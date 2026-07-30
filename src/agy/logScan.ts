// Detect backend failures that `agy --print` swallows (exit 0, empty stream)
// but records only in ~/.gemini/antigravity-cli/log/cli-*.log.

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_LOG_SCAN_BYTES = 256 * 1024;

const ERROR_ANCHORS = [
	"agent executor error:",
	"model unreachable:",
	"RESOURCE_EXHAUSTED",
] as const;

/** Snapshot of cli-*.log file sizes under <conversationsDir>/../log. */
export function snapshotAgyLogs(
	conversationsDir: string,
): Map<string, number> {
	const logDir = path.join(path.dirname(conversationsDir), "log");
	const snapshot = new Map<string, number>();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(logDir, { withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.error(
				`[agy-acp] cannot read agy log dir ${logDir}: ${(err as Error).message}; swallowed-error detection disabled this turn`,
			);
		}
		return snapshot;
	}

	for (const entry of entries) {
		if (!entry.isFile() || !isAgyCliLog(entry.name)) continue;
		try {
			const stat = fs.statSync(path.join(logDir, entry.name));
			snapshot.set(entry.name, stat.size);
		} catch (err) {
			console.error(
				`[agy-acp] cannot stat agy log ${entry.name}: ${(err as Error).message}; it will be treated as new next turn`,
			);
		}
	}
	return snapshot;
}

/**
 * Scan logs grown during this turn for a swallowed backend error.
 * Returns a cleaned message, or null when nothing matched.
 */
export function detectSwallowedAgyError(
	conversationsDir: string,
	preSnapshot: Map<string, number>,
	spawnTime: Date,
): string | null {
	const logDir = path.join(path.dirname(conversationsDir), "log");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(logDir, { withFileTypes: true });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.error(
				`[agy-acp] cannot read agy log dir ${logDir}: ${(err as Error).message}; swallowed-error detection skipped this turn`,
			);
		}
		return null;
	}

	type Candidate = {
		mtimeMs: number;
		filePath: string;
		offset: number;
		len: number;
	};
	const candidates: Candidate[] = [];

	for (const entry of entries) {
		if (!entry.isFile() || !isAgyCliLog(entry.name)) continue;
		const filePath = path.join(logDir, entry.name);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(filePath);
		} catch (err) {
			console.error(
				`[agy-acp] cannot stat agy log ${entry.name}: ${(err as Error).message}; excluded from this turn's swallowed-error scan`,
			);
			continue;
		}
		const offset = preSnapshot.get(entry.name) ?? 0;
		if (stat.size <= offset) continue;
		// Tolerate 1s FS mtime truncation so this turn's own log is not excluded.
		if (stat.mtimeMs + 1000 < spawnTime.getTime()) continue;
		candidates.push({
			mtimeMs: stat.mtimeMs,
			filePath,
			offset,
			len: stat.size,
		});
	}

	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

	let readFailures = 0;
	for (const candidate of candidates) {
		const content = readLogTail(
			candidate.filePath,
			candidate.offset,
			candidate.len,
		);
		if (content === null) {
			readFailures += 1;
			continue;
		}
		const msg = extractAgyErrorMessage(content);
		if (msg) return msg;
	}

	if (readFailures > 0) {
		console.error(
			`[agy-acp] swallowed-error scan: ${readFailures}/${candidates.length} grown log(s) could not be read; detection may have missed this turn's error`,
		);
	} else if (candidates.length > 0) {
		console.error(
			`[agy-acp] swallowed-error scan: no known error anchor in ${candidates.length} grown log(s)`,
		);
	}
	return null;
}

/** Decide whether a finished turn should surface as an error message. */
export function decideTurnError(opts: {
	wasCancelled: boolean;
	exitCode: number;
	hadUpdates: boolean;
	stderrText: string;
	swallowedError: string | null;
}): string | null {
	if (opts.wasCancelled || opts.hadUpdates) return null;
	if (opts.exitCode !== 0) {
		return opts.stderrText.length > 0
			? `agy failed: ${opts.stderrText}`
			: `agy exited with status: ${opts.exitCode}`;
	}
	return opts.swallowedError;
}

export function extractAgyErrorMessage(content: string): string | null {
	for (const anchor of ERROR_ANCHORS) {
		const lines = content.split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i] ?? "";
			if (!line.includes(anchor)) continue;
			const start = line.indexOf(anchor);
			if (start < 0) continue;
			let msg = line.slice(start).trim();
			const split = msg.split(".: ");
			if (split.length > 1) {
				msg = `${split[0]}.`;
			}
			return truncateToByteBoundary(msg, 500);
		}
	}
	return null;
}

function isAgyCliLog(name: string): boolean {
	return name.startsWith("cli-") && name.endsWith(".log");
}

function readLogTail(
	filePath: string,
	offset: number,
	len: number,
): string | null {
	try {
		const start = Math.max(offset, len - MAX_LOG_SCAN_BYTES);
		const fd = fs.openSync(filePath, "r");
		try {
			const size = Math.min(len - start, MAX_LOG_SCAN_BYTES);
			const buf = Buffer.alloc(size);
			fs.readSync(fd, buf, 0, size, start);
			return buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		console.error(
			`[agy-acp] cannot read agy log ${filePath}: ${(err as Error).message}`,
		);
		return null;
	}
}

function truncateToByteBoundary(s: string, max: number): string {
	if (Buffer.byteLength(s, "utf8") <= max) return s;
	let end = Math.min(s.length, max);
	let buf = Buffer.from(s.slice(0, end), "utf8");
	while (buf.length > max && end > 0) {
		end -= 1;
		buf = Buffer.from(s.slice(0, end), "utf8");
	}
	return s.slice(0, end);
}

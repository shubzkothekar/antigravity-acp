// Clone an agy conversation database under a fresh id, for ACP session/fork.
//
// agy has no fork of its own, but it resumes any conversation whose
// `<id>.db` exists in the conversations directory (`agy --conversation <id>`).
// A fork is therefore a consistent copy of the source database in which the
// conversation (cascade) id and trajectory id are swapped for new ones.
//
// Both ids appear in `trajectory_meta` and inside protobuf blobs (step
// metadata, payloads, generator metadata). They are UUID strings of the same
// length, so a byte-for-byte replacement keeps every protobuf length prefix
// valid.

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replace every occurrence of each key with its value, byte-wise. */
function replaceBytes(
	data: Uint8Array,
	replacements: Array<[Uint8Array, Uint8Array]>,
): Uint8Array | null {
	let buf = Buffer.from(data);
	let changed = false;
	for (const [from, to] of replacements) {
		if (from.length !== to.length) {
			throw new Error("fork id replacement must preserve length");
		}
		let at = buf.indexOf(from);
		if (at === -1) continue;
		if (!changed) {
			buf = Buffer.from(buf); // copy before mutating
			changed = true;
		}
		while (at !== -1) {
			buf.set(to, at);
			at = buf.indexOf(from, at + from.length);
		}
	}
	return changed ? buf : null;
}

/** Rewrite every text/blob cell containing one of the ids. */
function rewriteIds(db: Database, ids: Map<string, string>): void {
	const pairs: Array<[Uint8Array, Uint8Array]> = [...ids].map(([a, b]) => [
		Buffer.from(a),
		Buffer.from(b),
	]);
	const tables = db
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
		)
		.all()
		.map((r) => r.name);

	for (const table of tables) {
		const q = `"${table.replace(/"/g, '""')}"`;
		const columns = db
			.query<{ name: string }, []>(`PRAGMA table_info(${q})`)
			.all()
			.map((c) => c.name);
		const rows = db
			.query<Record<string, unknown>, []>(
				`SELECT rowid AS __rowid, * FROM ${q}`,
			)
			.all();
		for (const row of rows) {
			for (const col of columns) {
				const value = row[col];
				let next: unknown = null;
				if (value instanceof Uint8Array) {
					next = replaceBytes(value, pairs);
				} else if (typeof value === "string") {
					let s = value;
					for (const [a, b] of ids) s = s.split(a).join(b);
					if (s !== value) next = s;
				}
				if (next !== null) {
					const c = `"${col.replace(/"/g, '""')}"`;
					db.run(`UPDATE ${q} SET ${c} = ? WHERE rowid = ?`, [
						next as Uint8Array | string,
						row.__rowid as number,
					]);
				}
			}
		}
	}
}

export interface ForkResult {
	conversationId: string;
	/** Highest step idx in the clone (-1 if empty): where streaming resumes. */
	lastStepIdx: number;
}

/**
 * Copy conversation `sourceId` in `dir` to a new conversation id and return it.
 * The source database is only read. Throws if the source does not exist.
 */
export function forkConversation(dir: string, sourceId: string): ForkResult {
	if (!UUID_RE.test(sourceId)) {
		throw new Error(`not an agy conversation id: ${sourceId}`);
	}
	const sourcePath = path.join(dir, `${sourceId}.db`);
	if (!fs.existsSync(sourcePath)) {
		throw new Error(`agy conversation not found: ${sourceId}`);
	}

	const newId = crypto.randomUUID();
	const targetPath = path.join(dir, `${newId}.db`);

	// VACUUM INTO takes a transactionally consistent snapshot, including rows
	// still in the source's WAL, and writes no rows to the source. The source is
	// opened read-write on purpose: agy deletes the -wal/-shm files when it
	// exits, and SQLite cannot open a WAL database read-only without them.
	const source = new Database(sourcePath, { readwrite: true, create: false });
	try {
		source.run("VACUUM INTO ?", [targetPath]);
	} finally {
		source.close();
	}

	let lastStepIdx = -1;
	try {
		const target = new Database(targetPath);
		try {
			// VACUUM INTO always writes a rollback-journal database. agy keeps its
			// conversations in WAL mode; match it, or agy switches modes on its
			// first write and the read-only stream poller fails to open the file.
			target.run("PRAGMA journal_mode = WAL");
			const ids = new Map<string, string>([[sourceId, newId]]);
			const metas = target
				.query<{ trajectory_id: string | null }, []>(
					"SELECT trajectory_id FROM trajectory_meta",
				)
				.all();
			for (const m of metas) {
				if (m.trajectory_id && UUID_RE.test(m.trajectory_id)) {
					ids.set(m.trajectory_id, crypto.randomUUID());
				}
			}
			target.transaction(() => rewriteIds(target, ids))();
			const max = target
				.query<{ m: number | null }, []>("SELECT MAX(idx) AS m FROM steps")
				.get();
			lastStepIdx = max?.m ?? -1;
		} finally {
			target.close();
		}
		copyBrainDir(dir, sourceId, newId);
	} catch (err) {
		try {
			fs.unlinkSync(targetPath);
		} catch {}
		throw err;
	}

	return { conversationId: newId, lastStepIdx };
}

/** agy keeps per-conversation artifacts in `../brain/<id>`; copy them over so
 *  files the conversation refers to stay readable in the fork. Best effort. */
function copyBrainDir(
	conversationsDir: string,
	sourceId: string,
	newId: string,
) {
	const brain = path.join(conversationsDir, "..", "brain");
	const from = path.join(brain, sourceId);
	if (!fs.existsSync(from)) return;
	try {
		fs.cpSync(from, path.join(brain, newId), { recursive: true });
	} catch (err) {
		console.error(
			`[agy-acp] WARN: could not copy brain dir for fork: ${(err as Error).message}`,
		);
	}
}

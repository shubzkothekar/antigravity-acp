// Shared logic for downloading and installing the agy binary from GitHub Releases.
// Used by both scripts/postinstall.ts (npm install hook) and the server startup
// (auto-install when running as a compiled SEA without agy on PATH).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Release configuration ─────────────────────────────────────────────────────

export const GITHUB_REPO = "google-antigravity/antigravity-cli";
export const AGY_VERSION = "1.0.13";

export interface Release {
	asset: string;
	sha256: string;
	kind: "tar.gz" | "zip";
}

// Keyed by `${process.platform}-${process.arch}`.
// Update sha256 values together with AGY_VERSION.
export const RELEASES: Record<string, Release> = {
	"darwin-arm64": {
		asset: "agy_cli_mac_arm64.tar.gz",
		sha256: "c00b3aa10d4eee821f7ddaf3185942c88511ebbe425663692f7732d8dd1e83c2",
		kind: "tar.gz",
	},
	"darwin-x64": {
		asset: "agy_cli_mac_x64.tar.gz",
		sha256: "53e23ef3f54d0212df7fc73ea1eb99c34e4c97bffa1f886afe565fd142c9ab89",
		kind: "tar.gz",
	},
	"linux-arm64": {
		asset: "agy_cli_linux_arm64.tar.gz",
		sha256: "e2f062ff8a573d2da54c03c8f0b66e130a563a08c87b6db174953a9afdd21235",
		kind: "tar.gz",
	},
	"linux-x64": {
		asset: "agy_cli_linux_x64.tar.gz",
		sha256: "6bf990458c114af3b3173dcbc1b0fb9ab93bea91c53b605fdd69aedd29a21cd9",
		kind: "tar.gz",
	},
	"win32-arm64": {
		asset: "agy_cli_windows_arm64.zip",
		sha256: "e6a6fb4c9703cdd51c5d2c107b724e5bc5654a2850c8e1d737ee906ed5facdf8",
		kind: "zip",
	},
	"win32-x64": {
		asset: "agy_cli_windows_x64.zip",
		sha256: "ca397c0f07157b6f38a2e11a3c9e97ef56c24ec4238a0deef6a5dd390dee1836",
		kind: "zip",
	},
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function releaseUrl(asset: string): string {
	return `https://github.com/${GITHUB_REPO}/releases/download/${AGY_VERSION}/${asset}`;
}

export function sha256hex(buf: Buffer): string {
	return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function extractTarGz(
	archive: string,
	destDir: string,
): Promise<void> {
	const proc = Bun.spawn(["tar", "-xzf", archive, "-C", destDir], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr as ReadableStream).text();
		throw new Error(`tar exited ${exitCode}: ${stderr.trim()}`);
	}
}

export async function extractZip(
	archive: string,
	destDir: string,
): Promise<void> {
	const proc = Bun.spawn(
		[
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr as ReadableStream).text();
		throw new Error(`Expand-Archive exited ${exitCode}: ${stderr.trim()}`);
	}
}

export function findBinary(
	dir: string,
	name: string,
	maxDepth = 2,
): string | null {
	if (maxDepth < 0) return null;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return full;
		if (entry.isDirectory()) {
			const found = findBinary(full, name, maxDepth - 1);
			if (found) return found;
		}
	}
	return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InstallOptions {
	/** Directory to install the agy binary into. */
	destDir: string;
	/** Log function — use console.log in postinstall, console.error in server (stdout is the ACP wire). */
	log: (msg: string) => void;
	/** Warn function — same distinction as log. */
	warn: (msg: string) => void;
}

/**
 * Download and install the agy binary into opts.destDir.
 *
 * Skips silently when:
 *   - AGY_SKIP_DOWNLOAD=1
 *   - $AGY_BIN is set (user supplies their own binary)
 *   - the binary already exists and is executable in opts.destDir
 *
 * On error, warns and returns without throwing so callers can continue
 * (agy on $PATH is still a valid fallback).
 */
export async function ensureAgy(opts: InstallOptions): Promise<void> {
	const { destDir, log, warn } = opts;

	if (process.env.AGY_SKIP_DOWNLOAD === "1") {
		log("[agy-acp] skipping agy download (AGY_SKIP_DOWNLOAD=1)");
		return;
	}
	if (process.env.AGY_BIN) {
		log(`[agy-acp] using $AGY_BIN=${process.env.AGY_BIN}, skipping download`);
		return;
	}

	const platformKey = `${process.platform}-${process.arch}`;
	const release = RELEASES[platformKey];
	if (!release) {
		warn(
			`[agy-acp] WARN: unsupported platform ${platformKey}. ` +
				`Set $AGY_BIN to your agy binary path.`,
		);
		return;
	}

	const isWin = process.platform === "win32";
	const exeName = isWin ? "agy.exe" : "agy";
	const dest = path.join(destDir, exeName);

	// Already installed and executable — nothing to do.
	try {
		fs.accessSync(dest, fs.constants.X_OK);
		log(`[agy-acp] agy already present (${dest})`);
		return;
	} catch {
		// not present or not executable — fall through to download
	}

	const url = releaseUrl(release.asset);
	log(
		`[agy-acp] agy not found — downloading v${AGY_VERSION} for ${platformKey}...`,
	);

	let resp: Response;
	try {
		resp = await fetch(url, { redirect: "follow" });
	} catch (err) {
		warn(
			`[agy-acp] WARN: network error downloading agy: ${(err as Error).message}\n` +
				`  Set $AGY_BIN to your agy binary path as a workaround.`,
		);
		return;
	}
	if (!resp.ok) {
		warn(
			`[agy-acp] WARN: HTTP ${resp.status} ${resp.statusText} downloading agy from ${url}\n` +
				`  Set $AGY_BIN to your agy binary path as a workaround.`,
		);
		return;
	}

	const archiveBytes = Buffer.from(await resp.arrayBuffer());

	const actual = sha256hex(archiveBytes);
	if (actual !== release.sha256) {
		warn(
			`[agy-acp] WARN: SHA256 mismatch for ${release.asset}\n` +
				`  expected: ${release.sha256}\n` +
				`  got:      ${actual}\n` +
				`  Refusing to install — set $AGY_BIN as a workaround.`,
		);
		return;
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-"));
	try {
		const archivePath = path.join(tmpDir, release.asset);
		fs.writeFileSync(archivePath, archiveBytes);

		const extractDir = path.join(tmpDir, "extracted");
		fs.mkdirSync(extractDir);

		if (release.kind === "tar.gz") {
			await extractTarGz(archivePath, extractDir);
		} else {
			await extractZip(archivePath, extractDir);
		}

		const found = findBinary(extractDir, exeName);
		if (!found) {
			warn(
				`[agy-acp] WARN: could not locate ${exeName} inside ${release.asset}.\n` +
					`  Extracted contents: ${fs.readdirSync(extractDir).join(", ")}\n` +
					`  Set $AGY_BIN as a workaround.`,
			);
			return;
		}

		fs.mkdirSync(destDir, { recursive: true });
		fs.copyFileSync(found, dest);
		if (!isWin) fs.chmodSync(dest, 0o755);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}

	log(`[agy-acp] agy v${AGY_VERSION} installed → ${dest}`);
}

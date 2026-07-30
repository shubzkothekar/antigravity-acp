// Resolve the `agy` executable.
//
// Resolution order:
//   1. bin/agy (or bin/agy.exe)  — placed here by the postinstall script,
//      which downloads the correct binary from GitHub Releases.
//   2. $AGY_BIN                  — explicit override for custom builds / CI.
//   3. "agy" / "agy.exe"         — falls through to whatever $PATH provides.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function moduleDir(): string {
	// Prefer Bun's import.meta.dir; fall back to Node's import.meta.url.
	const dir = (import.meta as ImportMeta & { dir?: string }).dir;
	if (typeof dir === "string" && dir.length > 0) return dir;
	return path.dirname(fileURLToPath(import.meta.url));
}

/** Path where postinstall deposits the downloaded agy binary.
 *  - npm/npx install: looks in <package-root>/bin/
 *  - compiled SEA: looks next to the executable itself */
export function downloadedAgyPath(): string {
	const exe = process.platform === "win32" ? "agy.exe" : "agy";
	const base = path.basename(process.execPath).toLowerCase();
	const isRuntime =
		base === "bun" ||
		base === "bun.exe" ||
		base === "node" ||
		base === "node.exe";
	if (!isRuntime) {
		// Compiled single-executable application.
		return path.join(path.dirname(process.execPath), exe);
	}
	const packageRoot = path.resolve(moduleDir(), "..", "..");
	return path.join(packageRoot, "bin", exe);
}

/** Resolve the agy binary: downloaded binary → $AGY_BIN → PATH. */
export function resolveAgyBinary(): string {
	const downloaded = downloadedAgyPath();
	try {
		fs.accessSync(downloaded, fs.constants.X_OK);
		return downloaded;
	} catch {
		return (
			process.env.AGY_BIN || (process.platform === "win32" ? "agy.exe" : "agy")
		);
	}
}

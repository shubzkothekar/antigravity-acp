#!/usr/bin/env bun
// Entry point for the agy ACP server.

import * as fs from "node:fs";
import * as path from "node:path";
import pkg from "./package.json";
import { runAcp } from "./src/acp/server";
import { downloadedAgyPath } from "./src/agy/binary";
import { ensureAgy } from "./src/agy/installer";

async function main(): Promise<void> {
	if (process.argv.includes("--version") || process.argv.includes("-v")) {
		process.stdout.write(`${pkg.version}\n`);
		process.exit(0);
	}

	// stdout is the ACP wire — route every other log to stderr.
	console.log = console.error;
	console.info = console.error;
	console.warn = console.error;
	console.debug = console.error;

	process.on("unhandledRejection", (reason) => {
		console.error("[agy-acp] unhandled rejection:", reason);
	});

	// Auto-install agy if it isn't already present locally.
	// Skips when AGY_SKIP_DOWNLOAD=1, $AGY_BIN is set, or binary already exists.
	// A failure here is non-fatal: agy on $PATH still works as a fallback.
	const localBin = downloadedAgyPath();
	const alreadyPresent = (() => {
		try {
			fs.accessSync(localBin, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	})();
	if (!alreadyPresent) {
		await ensureAgy({
			destDir: path.dirname(localBin),
			log: console.error,
			warn: console.error,
		});
	}

	const { connection } = runAcp();

	const shutdown = () => process.exit(0);
	connection.closed.then(shutdown).catch(shutdown);
	process.on("SIGINT", shutdown);
	if (process.platform !== "win32") {
		process.on("SIGTERM", shutdown);
	}
}

main().catch((err: Error) => {
	process.stderr.write(`[agy-acp] fatal: ${err.message}\n`);
	process.exit(1);
});

#!/usr/bin/env node
// Download the agy binary from GitHub Releases for the current platform.
// Runs automatically after install via the postinstall hook (tsx/node).
//
// When cutting a new agy-acp release, update AGY_VERSION and the sha256 fields
// in src/agy/installer.ts (the sha256 values come from the GitHub release page).

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAgy } from "../src/agy/installer";

// scripts/ lives at {pkg}/scripts/ → bin/ is a sibling of scripts/
const here =
	typeof (import.meta as ImportMeta & { dir?: string }).dir === "string"
		? (import.meta as ImportMeta & { dir: string }).dir
		: path.dirname(fileURLToPath(import.meta.url));
const binDir = path.resolve(here, "..", "bin");

ensureAgy({
	destDir: binDir,
	log: console.log,
	warn: console.warn,
}).catch((err: Error) => {
	// Never let postinstall abort the broader install.
	console.warn(`[agy-acp] WARN: postinstall error: ${err.message}`);
});

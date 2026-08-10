#!/usr/bin/env node
// npx/node entry: execute TypeScript sources via tsx with no compile step.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = pathToFileURL(path.resolve(here, "..", "index.ts")).href;

// Register tsx's ESM loader, then import the TS entry.
const { register } = await import("tsx/esm/api");
register();
await import(entry);

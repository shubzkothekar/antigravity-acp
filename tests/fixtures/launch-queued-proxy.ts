import { writeSync } from "node:fs";
import { join } from "node:path";
import { spawnAgy } from "../../src/agy/process";

const lockFile = process.argv[2];
const markerFile = process.argv[3];
if (!lockFile || !markerFile) {
	throw new Error("usage: launch-queued-proxy.ts <lock-file> <marker-file>");
}

process.env.AGY_ACP_LOCK_FILE = lockFile;
process.env.AGY_ACP_PROXY_ENTRYPOINT = join(import.meta.dir, "../../index.ts");
const pending = spawnAgy(
	process.execPath,
	[join(import.meta.dir, "record-agy-launch.ts"), markerFile],
	process.cwd(),
);
writeSync(1, "queued\n");
const proxy = await pending;
await proxy.exited;

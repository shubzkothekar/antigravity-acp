import { writeSync } from "node:fs";
import { join } from "node:path";
import { spawnAgy } from "../../src/agy/process";

const lockFile = process.argv[2];
const startedFile = process.argv[3];
const finishedFile = process.argv[4];
if (!lockFile || !startedFile || !finishedFile) {
	throw new Error(
		"usage: launch-proxy-and-exit.ts <lock-file> <started-file> <finished-file>",
	);
}

process.env.AGY_ACP_LOCK_FILE = lockFile;
process.env.AGY_ACP_PROXY_ENTRYPOINT = join(import.meta.dir, "../../index.ts");
const proxy = await spawnAgy(
	process.execPath,
	[join(import.meta.dir, "slow-agy.ts"), startedFile, finishedFile, "300"],
	process.cwd(),
);
writeSync(1, `${proxy.pid}\n`);
process.exit(0);

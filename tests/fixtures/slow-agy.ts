import { writeFileSync } from "node:fs";

const startedFile = process.argv[2];
const finishedFile = process.argv[3];
const delayMs = Number(process.argv[4]);
if (!startedFile || !finishedFile || !Number.isFinite(delayMs)) {
	throw new Error(
		"usage: slow-agy.ts <started-file> <finished-file> <delay-ms>",
	);
}

writeFileSync(startedFile, "started");
await Bun.sleep(delayMs);
writeFileSync(finishedFile, "finished");

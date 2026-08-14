import { writeFileSync } from "node:fs";

const markerFile = process.argv[2];
if (!markerFile) throw new Error("missing marker file path");
writeFileSync(markerFile, "launched");

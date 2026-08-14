import { Database } from "bun:sqlite";

const lockFile = process.argv[2];
if (!lockFile) throw new Error("missing lock database path");

const database = new Database(lockFile, { create: true });
database.run("BEGIN EXCLUSIVE");
console.log("ready");

await new Promise(() => {});

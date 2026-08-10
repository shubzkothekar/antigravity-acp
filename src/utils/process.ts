// Cross-runtime process helpers (Node + Bun).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";

export interface SpawnedProcess {
	/** Resolves with the process exit code (or null if killed without code). */
	exited: Promise<number | null>;
	stderr: ReadableStream<Uint8Array> | null;
	kill(signal?: NodeJS.Signals | number): boolean;
	pid?: number;
}

/** Spawn a process with optional stdio. stderr is always piped when requested. */
export function spawnProcess(
	command: string,
	args: string[],
	opts: {
		cwd?: string;
		stdin?: "ignore";
		stdout?: "ignore" | "pipe";
		stderr?: "ignore" | "pipe";
	} = {},
): SpawnedProcess {
	const child = spawn(command, args, {
		cwd: opts.cwd,
		stdio: [
			opts.stdin === "ignore" || opts.stdin === undefined ? "ignore" : "pipe",
			opts.stdout === "pipe" ? "pipe" : "ignore",
			opts.stderr === "pipe" ? "pipe" : "ignore",
		],
	}) as ChildProcessWithoutNullStreams;

	const exited = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
	});

	let stderr: ReadableStream<Uint8Array> | null = null;
	if (opts.stderr === "pipe" && child.stderr) {
		stderr = Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>;
	}

	return {
		exited,
		stderr,
		kill: (signal) => child.kill(signal),
		pid: child.pid,
	};
}

/** Run a command and capture stdout as text. */
export async function runCapture(
	command: string,
	args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const child = spawn(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
	child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));

	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code));
	});

	return {
		exitCode,
		stdout: Buffer.concat(stdoutChunks).toString("utf8"),
		stderr: Buffer.concat(stderrChunks).toString("utf8"),
	};
}

/** Write text/bytes to a file (atomic enough for our uses). */
export async function writeFile(
	filePath: string,
	data: string | Uint8Array,
): Promise<void> {
	const { writeFile: wf } = await import("node:fs/promises");
	await wf(filePath, data);
}

/** Read a file as UTF-8 text. */
export async function readFileText(filePath: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(filePath, "utf8");
}

/** Create a WritableStream that writes binary chunks to process.stdout. */
export function stdoutWritable(): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				const ok = process.stdout.write(chunk, (err) => {
					if (err) reject(err);
					else resolve();
				});
				if (!ok) {
					process.stdout.once("drain", () => resolve());
				}
			});
		},
	});
}

/** ReadableStream of stdin bytes (for ACP ndjson). */
export function stdinReadable(): ReadableStream<Uint8Array> {
	return Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
}

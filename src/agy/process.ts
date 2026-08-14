// Spawning and querying the agy CLI via Bun's native process APIs.

import { Database } from "bun:sqlite";
import { spawn as spawnChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { Readable, type Writable } from "node:stream";
import { STATE_DIR } from "../constants";

const BYPASS_MODES = new Set(["bypassPermissions", "bypass", "dontAsk"]);
const LOCK_POLL_INTERVAL_MS = 50;
export const AGY_PROCESS_PROXY_FLAG = "--internal-agy-process-proxy";
const AGY_PROCESS_PROXY_READY_FD = "AGY_ACP_PROCESS_PROXY_READY_FD";
const AGY_PROCESS_PROXY_CONTROL_FD = "AGY_ACP_PROCESS_PROXY_CONTROL_FD";
const AGY_PROCESS_PROXY_REQUEST_FD = "AGY_ACP_PROCESS_PROXY_REQUEST_FD";

interface AgyProcessProxyRequest {
	binary: string;
	args: string[];
	cwd: string;
}

export interface AgySubprocess {
	readonly stderr: ReadableStream<Uint8Array> | null;
	readonly exited: Promise<number>;
	readonly pid: number;
	kill(signal?: NodeJS.Signals): void;
}

export class AgyProcessCancelledError extends Error {
	constructor() {
		super("agy process start cancelled");
		this.name = "AgyProcessCancelledError";
	}
}

function agyProcessLockFile(): string {
	return (
		process.env.AGY_ACP_LOCK_FILE ||
		path.join(STATE_DIR, "agy-process-lock.sqlite")
	);
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new AgyProcessCancelledError();
}

function isSqliteBusy(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const record = error as { code?: unknown; errno?: unknown };
	return record.code === "SQLITE_BUSY" || record.errno === 5;
}

function waitForLockRetry(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(done, LOCK_POLL_INTERVAL_MS);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(new AgyProcessCancelledError());
		};
		function done() {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
}

async function acquireAgyProcessLock(
	signal?: AbortSignal,
): Promise<() => void> {
	const lockFile = agyProcessLockFile();
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	const database = new Database(lockFile, { create: true });
	database.run("PRAGMA busy_timeout = 0");

	try {
		for (;;) {
			throwIfCancelled(signal);
			try {
				database.run("BEGIN EXCLUSIVE");
				break;
			} catch (error) {
				if (!isSqliteBusy(error)) throw error;
				await waitForLockRetry(signal);
			}
		}

		let released = false;
		return () => {
			if (released) return;
			released = true;
			try {
				database.run("ROLLBACK");
			} catch (error) {
				console.error(
					`[agy-acp] failed to release agy process lock: ${(error as Error).message}`,
				);
			}
			try {
				database.close();
			} catch (error) {
				console.error(
					`[agy-acp] failed to close agy process lock: ${(error as Error).message}`,
				);
			}
		};
	} catch (error) {
		database.close();
		throw error;
	}
}

function encodeProxyRequest(request: AgyProcessProxyRequest): string {
	return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

function parseProxyRequest(value: unknown): AgyProcessProxyRequest {
	if (
		!value ||
		typeof value !== "object" ||
		!("binary" in value) ||
		typeof value.binary !== "string" ||
		!("args" in value) ||
		!Array.isArray(value.args) ||
		!value.args.every((arg) => typeof arg === "string") ||
		!("cwd" in value) ||
		typeof value.cwd !== "string"
	) {
		throw new Error("invalid agy process proxy request");
	}
	return { binary: value.binary, args: value.args, cwd: value.cwd };
}

function decodeProxyRequest(encoded: string): AgyProcessProxyRequest {
	return parseProxyRequest(
		JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown,
	);
}

function proxyEntrypointCommand(): string[] {
	const entrypoint = process.env.AGY_ACP_PROXY_ENTRYPOINT || Bun.main;
	const command = [process.execPath];
	if (path.resolve(entrypoint) !== path.resolve(process.execPath)) {
		command.push(entrypoint);
	}
	command.push(AGY_PROCESS_PROXY_FLAG);
	return command;
}

function proxyCommand(request: AgyProcessProxyRequest): string[] {
	return [...proxyEntrypointCommand(), encodeProxyRequest(request)];
}

function readProxyRequest(encoded?: string): AgyProcessProxyRequest {
	const descriptor = Number(process.env[AGY_PROCESS_PROXY_REQUEST_FD]);
	if (Number.isInteger(descriptor) && descriptor >= 0) {
		try {
			return parseProxyRequest(
				JSON.parse(fs.readFileSync(descriptor, "utf8")) as unknown,
			);
		} finally {
			fs.closeSync(descriptor);
		}
	}
	if (!encoded) throw new Error("missing agy process proxy request");
	return decodeProxyRequest(encoded);
}

interface ProxyHandshake {
	ready: number;
	lines: ReturnType<typeof createInterface>;
	iterator: AsyncIterator<string>;
}

function createProxyHandshake(): ProxyHandshake | null {
	const ready = Number(process.env[AGY_PROCESS_PROXY_READY_FD]);
	const control = Number(process.env[AGY_PROCESS_PROXY_CONTROL_FD]);
	if (
		!Number.isInteger(ready) ||
		ready < 3 ||
		!Number.isInteger(control) ||
		control < 3
	) {
		return null;
	}
	const controlStream = fs.createReadStream(process.execPath, {
		fd: control,
		autoClose: true,
	});
	const lines = createInterface({ input: controlStream });
	return { ready, lines, iterator: lines[Symbol.asyncIterator]() };
}

async function nextProxyCommand(
	handshake: ProxyHandshake,
): Promise<string | null> {
	const message = await handshake.iterator.next();
	return message.done ? null : message.value;
}

function writeProxySignal(descriptor: number, message: string): void {
	try {
		fs.writeSync(descriptor, `${message}\n`);
	} catch {
		// The bridge may have exited after authorizing the start. Keep holding the
		// lock until agy exits even when nobody remains to receive the signal.
	}
	try {
		fs.closeSync(descriptor);
	} catch {
		// The descriptor may already be closed after a failed write.
	}
}

function signalProxyReady(descriptor: number): void {
	writeProxySignal(descriptor, "ready");
}

function signalProxyError(descriptor: number, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	writeProxySignal(
		descriptor,
		`error:${Buffer.from(message, "utf8").toString("base64url")}`,
	);
}

/** Internal subprocess entrypoint. The proxy owns the SQLite transaction and
 *  outlives the ACP bridge if the bridge exits unexpectedly, so serialization
 *  remains in force until the actual agy child exits. */
export async function runAgyProcessProxy(encoded?: string): Promise<number> {
	const request = readProxyRequest(encoded);
	const controller = new AbortController();
	const handshake = createProxyHandshake();
	const firstCommand = handshake ? nextProxyCommand(handshake) : null;
	if (firstCommand) {
		void firstCommand.then(
			(command) => {
				if (command === null || command === "cancel") controller.abort();
			},
			() => controller.abort(),
		);
	}
	let child: Bun.Subprocess | undefined;
	const stop = (signal: NodeJS.Signals) => {
		controller.abort();
		if (!child) return;
		if (process.platform === "win32") {
			child.kill();
		} else {
			child.kill(signal);
		}
	};
	const onSigint = () => stop("SIGINT");
	const onSigterm = () => stop("SIGTERM");
	process.once("SIGINT", onSigint);
	if (process.platform !== "win32") process.once("SIGTERM", onSigterm);

	let release: (() => void) | undefined;
	try {
		release = await acquireAgyProcessLock(controller.signal);
		throwIfCancelled(controller.signal);
		if (handshake && firstCommand) {
			try {
				fs.writeSync(handshake.ready, "locked\n");
			} catch {
				return 130;
			}
			const command = await firstCommand;
			if (command === null || command === "cancel") return 130;
			if (command !== "start") {
				throw new Error("invalid agy process proxy command");
			}
		}
		throwIfCancelled(controller.signal);
		try {
			child = Bun.spawn([request.binary, ...request.args], {
				cwd: request.cwd,
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
			});
		} catch (error) {
			if (handshake) signalProxyError(handshake.ready, error);
			throw error;
		}
		if (handshake) signalProxyReady(handshake.ready);
		if (handshake) {
			void nextProxyCommand(handshake).then(
				(command) => {
					if (command !== "cancel" || !child) return;
					if (process.platform === "win32") {
						child.kill();
					} else {
						child.kill("SIGINT");
					}
				},
				() => {
					// A closed control pipe means the bridge exited. The proxy keeps
					// owning the lock until agy finishes.
				},
			);
		}
		return await child.exited;
	} catch (error) {
		if (error instanceof AgyProcessCancelledError) return 130;
		throw error;
	} finally {
		release?.();
		handshake?.lines.close();
		process.removeListener("SIGINT", onSigint);
		if (process.platform !== "win32") {
			process.removeListener("SIGTERM", onSigterm);
		}
	}
}

/** Query agy for the list of available model ids (empty on any failure).
 *  Uses async spawn to avoid blocking the event loop (~5s for `agy models`). */
export async function discoverModels(binary: string): Promise<string[]> {
	try {
		const request = { binary, args: ["models"], cwd: process.cwd() };
		const proc = Bun.spawn(proxyCommand(request), {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const text = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return [];
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

export interface AgyArgsOptions {
	workingDir: string;
	/** Extra workspace roots to add via --add-dir (in addition to workingDir). */
	additionalDirs?: string[];
	conversationId: string | null;
	modelId: string | null;
	permissionMode: string | null;
	prompt: string;
	/** Extra args from $AGY_EXTRA_ARGS, already split. */
	extraArgs?: string[];
}

/** Build the agy CLI argument vector for a single prompt turn. */
export function buildAgyArgs(opts: AgyArgsOptions): string[] {
	const args = ["--add-dir", opts.workingDir];
	for (const dir of opts.additionalDirs ?? []) {
		args.push("--add-dir", dir);
	}
	if (opts.extraArgs?.length) args.push(...opts.extraArgs);
	if (opts.conversationId) args.push("--conversation", opts.conversationId);
	if (opts.modelId) args.push("--model", opts.modelId);
	if (opts.permissionMode && BYPASS_MODES.has(opts.permissionMode)) {
		args.push("--dangerously-skip-permissions");
	}
	args.push("-p", opts.prompt);
	return args;
}

/** Spawn agy for a prompt. stdout is ignored (agy persists to its DB); stderr is
 *  piped so the caller can surface failures. */
export async function spawnAgy(
	binary: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	onLockAcquired?: () => void,
): Promise<AgySubprocess> {
	throwIfCancelled(signal);
	const request = { binary, args, cwd };
	const command = proxyEntrypointCommand();
	const child = spawnChildProcess(command[0] as string, command.slice(1), {
		cwd,
		env: {
			...process.env,
			[AGY_PROCESS_PROXY_READY_FD]: "3",
			[AGY_PROCESS_PROXY_CONTROL_FD]: "4",
			[AGY_PROCESS_PROXY_REQUEST_FD]: "0",
		},
		stdio: ["pipe", "ignore", "pipe", "pipe", "pipe"],
	});
	child.unref();
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
	const readyStream = child.stdio[3] as Readable | null;
	const controlStream = child.stdio[4] as Writable | null;
	const requestStream = child.stdin;
	let cancelSent = false;
	const subprocess: AgySubprocess = {
		stderr: child.stderr
			? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>)
			: null,
		exited,
		pid: child.pid as number,
		kill: (killSignal) => {
			if (cancelSent) return;
			if (
				controlStream &&
				!controlStream.destroyed &&
				!controlStream.writableEnded
			) {
				try {
					controlStream.write("cancel\n");
					cancelSent = true;
					return;
				} catch {
					// Fall through to direct termination if IPC is unavailable.
				}
			}
			child.kill(killSignal);
		},
	};
	if (signal) {
		const onAbort = () => {
			if (process.platform === "win32") {
				subprocess.kill();
			} else {
				subprocess.kill("SIGINT");
			}
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		void subprocess.exited.then(
			() => signal.removeEventListener("abort", onAbort),
			() => signal.removeEventListener("abort", onAbort),
		);
	}
	if (!readyStream || !controlStream || !requestStream) {
		subprocess.kill();
		throw new Error("agy process proxy handshake pipe unavailable");
	}
	requestStream.end(JSON.stringify(request));
	const lines = createInterface({ input: readyStream });
	const iterator = lines[Symbol.asyncIterator]();
	const waitForMessage = async (expected: string): Promise<void> => {
		const message = await iterator.next();
		if (!message.done && message.value.startsWith("error:")) {
			const encodedError = message.value.slice("error:".length);
			throw new Error(Buffer.from(encodedError, "base64url").toString("utf8"));
		}
		if (message.done || message.value !== expected) {
			throw new Error(`invalid agy process proxy ${expected} signal`);
		}
	};
	try {
		await waitForMessage("locked");
		throwIfCancelled(signal);
		onLockAcquired?.();
		controlStream.write("start\n");
		await waitForMessage("ready");
		lines.close();
		throwIfCancelled(signal);
	} catch (error) {
		lines.close();
		if (signal?.aborted) throw new AgyProcessCancelledError();
		subprocess.kill();
		throw error;
	}
	return subprocess;
}

/** Read $AGY_EXTRA_ARGS into a token list. */
export function extraArgsFromEnv(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

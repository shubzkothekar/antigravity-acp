// Long-lived agy interactive runtime backed by Bun's cross-platform PTY.
// The terminal output is used only to detect busy/idle lifecycle transitions;
// user-visible content continues to come from the conversation database.

import { buildInteractiveAgyArgs } from "./process";

const BUSY_MARKER = "esc to cancel";
const IDLE_MARKER = "? for shortcuts";
const TRUST_MARKER = "Do you trust the contents of this project?";
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_SETTLE_MS = 250;
const TERMINAL_TAIL_LIMIT = 4096;
const SCAN_OVERLAP = 256;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI_OSC_PATTERN = new RegExp(
	`${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`,
	"g",
);
const ANSI_CSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

type TerminalState = "unknown" | "busy" | "idle";

export interface TerminalCheckpoint {
	busyGeneration: number;
	idleGeneration: number;
	trustGeneration: number;
}

/**
 * Tracks lifecycle markers emitted by the agy TUI without attempting to emulate
 * the whole terminal screen. Absolute marker offsets prevent overlap rescans
 * from replaying an older state transition.
 */
export class TerminalStateTracker {
	private state: TerminalState = "unknown";
	private busyGeneration = 0;
	private idleGeneration = 0;
	private trustGeneration = 0;
	private totalChars = 0;
	private lastMarkerOffset = -1;
	private lastStateChangeAt = 0;
	private scanOverlap = "";
	private tail = "";

	feed(text: string, now = Date.now()): void {
		const clean = stripTerminalControl(text);
		if (!clean) return;

		const combined = this.scanOverlap + clean;
		const combinedStart = this.totalChars - this.scanOverlap.length;
		const marker =
			/esc to cancel|\? for shortcuts|Do you trust the contents of this project\?/g;
		for (const match of combined.matchAll(marker)) {
			const relative = match.index ?? -1;
			if (relative < 0) continue;
			const absolute = combinedStart + relative;
			if (absolute <= this.lastMarkerOffset) continue;
			this.lastMarkerOffset = absolute;

			switch (match[0]) {
				case BUSY_MARKER:
					if (this.state !== "busy") {
						this.state = "busy";
						this.busyGeneration++;
						this.lastStateChangeAt = now;
					}
					break;
				case IDLE_MARKER:
					if (this.state !== "idle") {
						this.state = "idle";
						this.idleGeneration++;
						this.lastStateChangeAt = now;
					}
					break;
				case TRUST_MARKER:
					this.trustGeneration++;
					break;
			}
		}

		this.totalChars += clean.length;
		this.scanOverlap = combined.slice(-SCAN_OVERLAP);
		this.tail = (this.tail + clean).slice(-TERMINAL_TAIL_LIMIT);
	}

	checkpoint(): TerminalCheckpoint {
		return {
			busyGeneration: this.busyGeneration,
			idleGeneration: this.idleGeneration,
			trustGeneration: this.trustGeneration,
		};
	}

	turnCompleted(checkpoint: TerminalCheckpoint, now = Date.now()): boolean {
		return (
			this.busyGeneration > checkpoint.busyGeneration &&
			this.idleGeneration > checkpoint.idleGeneration &&
			this.state === "idle" &&
			now - this.lastStateChangeAt >= IDLE_SETTLE_MS
		);
	}

	trustPromptedAfter(checkpoint: TerminalCheckpoint): boolean {
		return this.trustGeneration > checkpoint.trustGeneration;
	}

	diagnosticTail(): string {
		return this.tail.trim();
	}
}

export interface InteractiveAgyOptions {
	binary: string;
	workingDir: string;
	additionalDirs: string[];
	conversationId: string | null;
	modelId: string | null;
	permissionMode: string | null;
	extraArgs: string[];
	promptTimeoutMs?: number;
}

/** One long-lived agy TUI process bound to one ACP session/conversation. */
export class InteractiveAgyProcess {
	private readonly tracker = new TerminalStateTracker();
	private readonly decoder = new TextDecoder();
	private terminal: Bun.Terminal | null = null;
	private child: Bun.Subprocess | null = null;
	private activeTurn = false;
	private closing = false;
	private boundConversationId: string | null;

	constructor(private readonly options: InteractiveAgyOptions) {
		this.boundConversationId = options.conversationId;
	}

	get conversationId(): string | null {
		return this.boundConversationId;
	}

	get alive(): boolean {
		return this.child !== null && this.child.exitCode === null && !this.closing;
	}

	bindConversation(conversationId: string | null): void {
		if (conversationId) this.boundConversationId = conversationId;
	}

	isCompatible(options: InteractiveAgyOptions): boolean {
		return (
			this.alive &&
			this.options.binary === options.binary &&
			this.options.workingDir === options.workingDir &&
			this.options.modelId === options.modelId &&
			this.options.permissionMode === options.permissionMode &&
			this.boundConversationId === options.conversationId &&
			arrayEquals(this.options.additionalDirs, options.additionalDirs) &&
			arrayEquals(this.options.extraArgs, options.extraArgs)
		);
	}

	/** Start the TUI with the first prompt, or paste a later prompt into it. */
	async runTurn(prompt: string): Promise<void> {
		if (this.activeTurn)
			throw new Error("agy interactive session already has an active turn");
		if (this.closing) throw new Error("agy interactive session is closing");

		this.activeTurn = true;
		const checkpoint = this.tracker.checkpoint();
		try {
			if (this.child === null) {
				this.start(prompt);
			} else {
				await this.submitPrompt(prompt);
			}
			await this.waitForTurn(checkpoint);
		} finally {
			this.activeTurn = false;
		}
	}

	/** Ask the TUI to cancel the current generation. */
	cancelTurn(): void {
		if (!this.activeTurn || !this.terminal || this.terminal.closed) return;
		this.terminal.write("\u001b");

		// If the TUI does not return to idle, terminate it so ACP cancellation
		// cannot leave a permanently wedged session runtime.
		setTimeout(() => {
			if (this.activeTurn) this.forceStop();
		}, 2_000);
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;

		const child = this.child;
		const terminal = this.terminal;
		if (child && child.exitCode === null && terminal && !terminal.closed) {
			terminal.write("\u0003");
			await sleep(75);
			terminal.write("\u0003");
			await Promise.race([child.exited.then(() => undefined), sleep(300)]);
		}
		if (child?.exitCode === null) child.kill();
		if (terminal && !terminal.closed) terminal.close();

		this.child = null;
		this.terminal = null;
	}

	private start(prompt: string): void {
		const terminal = new Bun.Terminal({
			cols: 120,
			rows: 40,
			data: (_terminal, data) => {
				const text = this.decoder.decode(data, { stream: true });
				this.tracker.feed(text);
			},
		});

		const args = buildInteractiveAgyArgs({
			workingDir: this.options.workingDir,
			additionalDirs: this.options.additionalDirs,
			conversationId: this.options.conversationId,
			modelId: this.options.modelId,
			permissionMode: this.options.permissionMode,
			prompt,
			extraArgs: this.options.extraArgs,
		});

		try {
			this.child = Bun.spawn([this.options.binary, ...args], {
				cwd: this.options.workingDir,
				terminal,
			});
			this.terminal = terminal;
		} catch (error) {
			terminal.close();
			throw error;
		}
	}

	private async submitPrompt(prompt: string): Promise<void> {
		const terminal = this.terminal;
		if (!terminal || terminal.closed || !this.alive) {
			throw new Error("agy interactive process is not available");
		}

		// Bracketed paste keeps embedded context/newlines inside the editor instead
		// of treating every newline as a separate submitted prompt.
		const safePrompt = sanitizePromptForTerminal(prompt);
		await writeAll(
			terminal,
			`${BRACKETED_PASTE_START}${safePrompt}${BRACKETED_PASTE_END}`,
		);
		await sleep(20);
		await writeAll(terminal, "\r");
	}

	private async waitForTurn(checkpoint: TerminalCheckpoint): Promise<void> {
		const timeoutMs = this.options.promptTimeoutMs ?? promptTimeoutMsFromEnv();
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (this.tracker.trustPromptedAfter(checkpoint)) {
				throw new Error(
					`agy requires workspace trust for ${this.options.workingDir}; run agy in that directory once and approve it`,
				);
			}
			if (this.tracker.turnCompleted(checkpoint)) return;

			const exitCode = this.child?.exitCode;
			if (exitCode !== null && exitCode !== undefined) {
				const detail = this.tracker.diagnosticTail();
				throw new Error(
					detail
						? `agy interactive process exited with status ${exitCode}: ${detail}`
						: `agy interactive process exited with status ${exitCode}`,
				);
			}
			await sleep(25);
		}

		const detail = this.tracker.diagnosticTail();
		throw new Error(
			detail
				? `agy interactive prompt timed out after ${timeoutMs}ms: ${detail}`
				: `agy interactive prompt timed out after ${timeoutMs}ms`,
		);
	}

	private forceStop(): void {
		if (this.child?.exitCode === null) this.child.kill();
		if (this.terminal && !this.terminal.closed) this.terminal.close();
	}
}

export function persistentAgyEnabled(): boolean {
	return (
		process.env.AGY_PERSISTENT !== "0" && typeof Bun.Terminal === "function"
	);
}

export function promptTimeoutMsFromEnv(): number {
	const raw = process.env.AGY_PROMPT_TIMEOUT_MS;
	if (!raw) return DEFAULT_PROMPT_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: DEFAULT_PROMPT_TIMEOUT_MS;
}

function arrayEquals(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function sanitizePromptForTerminal(prompt: string): string {
	return filterCharacters(
		prompt.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
		(code) => code !== 0 && code !== 27,
	);
}

async function writeAll(terminal: Bun.Terminal, input: string): Promise<void> {
	const bytes = new TextEncoder().encode(input);
	let offset = 0;
	while (offset < bytes.length) {
		const written = terminal.write(bytes.subarray(offset));
		if (written > 0) {
			offset += written;
		} else {
			await sleep(5);
		}
	}
}

function stripTerminalControl(input: string): string {
	const withoutAnsi = input
		.replace(ANSI_OSC_PATTERN, "")
		.replace(ANSI_CSI_PATTERN, "");
	return filterCharacters(
		withoutAnsi,
		(code) =>
			!(
				(code >= 0 && code <= 8) ||
				code === 11 ||
				code === 12 ||
				(code >= 14 && code <= 31) ||
				code === 127
			),
	);
}

function filterCharacters(
	input: string,
	keep: (code: number) => boolean,
): string {
	let output = "";
	for (const char of input) {
		if (keep(char.charCodeAt(0))) output += char;
	}
	return output;
}

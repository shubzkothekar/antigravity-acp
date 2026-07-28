// Prompt-turn runtime: spawn agy, poll its DB while it runs, stream updates to
// the client, and finalize. Bridges the agy subprocess and the conversation
// streaming layer.

import {
	AgyProcessCancelledError,
	type AgySubprocess,
	buildAgyArgs,
	extraArgsFromEnv,
	spawnAgy,
} from "../agy/process";
import { POLL_INTERVAL_MS } from "../constants";
import { conversationSnapshot } from "../conversation/scan";
import { StreamPoller } from "../conversation/streaming";
import type { Session } from "../types/session";
import type { AcpClient } from "./client";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PromptOutcome {
	stopReason: "end_turn" | "cancelled";
	conversationId: string | null;
	lastStepIdx: number;
	hadUpdates: boolean;
	/** Set when agy failed to start, or exited non-zero with nothing streamed. */
	error?: string;
}

export interface AdapterConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	skipNarration: boolean;
}

export class Adapter {
	private readonly children = new Map<string, AgySubprocess>();

	constructor(private readonly config: AdapterConfig) {}

	/** Request cancellation of an in-flight prompt for a session. */
	cancel(sessionId: string): void {
		const child = this.children.get(sessionId);
		if (child) {
			// SIGINT allows agy to flush its DB before exiting; on Windows we fall
			// back to an ungraceful kill because SIGINT is not a real signal there.
			if (process.platform === "win32") {
				child.kill();
			} else {
				child.kill("SIGINT");
			}
		}
	}

	/** Run a prompt turn end-to-end: spawn agy, stream deltas, finalize. */
	async runPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
		signal?: AbortSignal,
	): Promise<PromptOutcome> {
		if (signal?.aborted) {
			return {
				stopReason: "cancelled",
				conversationId: session.conversationId,
				lastStepIdx: session.lastStepIdx,
				hadUpdates: false,
			};
		}

		// Use the session's cwd if set, otherwise fall back to the server's workingDir.
		const effectiveCwd = session.cwd || this.config.workingDir;

		// Snapshot existing conversations while this prompt owns the global agy
		// process lock, immediately before the child starts.
		let snapshot: Set<string> | null = null;

		const args = buildAgyArgs({
			workingDir: effectiveCwd,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			permissionMode: session.permissionMode,
			prompt: promptText,
			extraArgs: extraArgsFromEnv(),
		});

		let child: AgySubprocess;
		try {
			child = await spawnAgy(
				this.config.binary,
				args,
				effectiveCwd,
				signal,
				() => {
					if (session.conversationId === null) {
						snapshot = conversationSnapshot(this.config.conversationsDir);
					}
				},
			);
		} catch (err) {
			if (signal?.aborted || err instanceof AgyProcessCancelledError) {
				return {
					stopReason: "cancelled",
					conversationId: session.conversationId,
					lastStepIdx: session.lastStepIdx,
					hadUpdates: false,
				};
			}
			return {
				stopReason: "end_turn",
				conversationId: session.conversationId,
				lastStepIdx: session.lastStepIdx,
				hadUpdates: false,
				error: `failed to run agy: ${(err as Error).message}`,
			};
		}
		this.children.set(sessionId, child);
		if (signal?.aborted) this.cancel(sessionId);

		// Drain stderr concurrently (resolves when the process exits).
		const stderrPromise = child.stderr
			? new Response(child.stderr as ReadableStream).text()
			: Promise.resolve("");

		const poller = new StreamPoller({
			dir: this.config.conversationsDir,
			conversationId: session.conversationId,
			baseStepIdx: session.lastStepIdx,
			skipNarration: this.config.skipNarration,
			cwd: effectiveCwd,
			snapshot,
		});

		// Serialized poll loop: emit updates in order, never overlapping.
		const pollOnce = async () => {
			for (const update of poller.poll()) {
				await client.update(sessionId, update);
			}
		};

		let polling = true;
		const loop = (async () => {
			while (polling) {
				try {
					await pollOnce();
				} catch (err) {
					console.error(`[agy-acp] poll error: ${(err as Error).message}`);
				}
				if (!polling) break;
				await sleep(POLL_INTERVAL_MS);
			}
		})();

		const exitCode = await child.exited;
		polling = false;
		await loop;
		this.children.delete(sessionId);

		// A few trailing polls to catch rows flushed right around exit.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await pollOnce();
			} catch (err) {
				console.error(`[agy-acp] final poll error: ${(err as Error).message}`);
			}
			if (attempt < 2) await sleep(100);
		}
		poller.close();

		const stderr = (await stderrPromise).trim();
		if (stderr.length > 0) console.error(`[agy-acp] agy stderr: ${stderr}`);

		const wasCancelled = signal?.aborted ?? false;

		const outcome: PromptOutcome = {
			stopReason: wasCancelled ? "cancelled" : "end_turn",
			conversationId: poller.conversationId,
			lastStepIdx: poller.lastStepIdx,
			hadUpdates: poller.hadUpdates,
		};

		if (!wasCancelled && exitCode !== 0) {
			console.error(`[agy-acp] WARN: agy exited with status ${exitCode}`);
			if (!poller.hadUpdates) {
				outcome.error =
					stderr.length > 0
						? `agy failed: ${stderr}`
						: `agy exited with status: ${exitCode}`;
			}
		}

		return outcome;
	}
}

// Prompt-turn runtime: spawn agy, poll its DB while it runs, stream updates to
// the client, and finalize. Bridges the agy subprocess and the conversation
// streaming layer.

import {
	decideTurnError,
	detectSwallowedAgyError,
	snapshotAgyLogs,
} from "../agy/logScan";
import type { CondensedModel } from "../agy/models";
import { buildAgyArgs, extraArgsFromEnv, spawnAgy } from "../agy/process";
import { POLL_INTERVAL_MS } from "../constants";
import { conversationSnapshot } from "../conversation/scan";
import { StreamPoller } from "../conversation/streaming";
import type { Session } from "../types/session";
import type { SpawnedProcess } from "../utils/process";
import type { AcpClient } from "./client";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface PromptOutcome {
	stopReason: "end_turn" | "cancelled" | "error";
	conversationId: string | null;
	lastStepIdx: number;
	hadUpdates: boolean;
	/** Set when agy failed to start, exited non-zero, or swallowed a backend error. */
	error?: string;
}

export interface AdapterConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	skipNarration: boolean;
	/** Live condensed model catalog for model+effort → backend id mapping. */
	getModels?: () => CondensedModel[];
}

export class Adapter {
	private readonly children = new Map<string, SpawnedProcess>();
	private readonly cancelled = new Set<string>();

	constructor(private readonly config: AdapterConfig) {}

	/** Request cancellation of an in-flight prompt for a session. */
	cancel(sessionId: string): void {
		this.cancelled.add(sessionId);
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
	): Promise<PromptOutcome> {
		this.cancelled.delete(sessionId);

		// Use the session's cwd if set, otherwise fall back to the server's workingDir.
		const effectiveCwd = session.cwd || this.config.workingDir;

		// Snapshot existing conversations so we can bind the new DB agy creates.
		const snapshot =
			session.conversationId === null
				? conversationSnapshot(this.config.conversationsDir)
				: null;

		const logPreSnapshot = snapshotAgyLogs(this.config.conversationsDir);
		const spawnTime = new Date();

		const args = buildAgyArgs({
			workingDir: effectiveCwd,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			models: this.config.getModels?.() ?? [],
			permissionMode: session.permissionMode,
			effort: session.effort,
			sandbox: session.sandbox,
			skipPermissions: session.skipPermissions,
			prompt: promptText,
			extraArgs: extraArgsFromEnv(),
		});

		let child: SpawnedProcess;
		try {
			child = spawnAgy(this.config.binary, args, effectiveCwd);
		} catch (err) {
			return {
				stopReason: "error",
				conversationId: session.conversationId,
				lastStepIdx: session.lastStepIdx,
				hadUpdates: false,
				error: `failed to run agy: ${(err as Error).message}`,
			};
		}
		this.children.set(sessionId, child);

		// Drain stderr concurrently (resolves when the process exits).
		const stderrPromise = child.stderr
			? new Response(child.stderr).text()
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

		const wasCancelled = this.cancelled.delete(sessionId);

		const code = exitCode ?? 1;

		if (!wasCancelled && code !== 0) {
			console.error(`[agy-acp] WARN: agy exited with status ${code}`);
		}

		const swallowedError =
			!wasCancelled && code === 0 && !poller.hadUpdates
				? detectSwallowedAgyError(
						this.config.conversationsDir,
						logPreSnapshot,
						spawnTime,
					)
				: null;

		const errorMessage = decideTurnError({
			wasCancelled,
			exitCode: code,
			hadUpdates: poller.hadUpdates,
			stderrText: stderr,
			swallowedError,
		});

		if (errorMessage) {
			console.error(`[agy-acp] surfacing turn error: ${errorMessage}`);
		}

		const outcome: PromptOutcome = {
			stopReason: wasCancelled
				? "cancelled"
				: errorMessage
					? "error"
					: "end_turn",
			conversationId: poller.conversationId,
			lastStepIdx: poller.lastStepIdx,
			hadUpdates: poller.hadUpdates,
		};
		if (errorMessage) outcome.error = errorMessage;

		return outcome;
	}
}

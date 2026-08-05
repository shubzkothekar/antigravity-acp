// Prompt-turn runtime: drive agy, poll its DB while it runs, stream updates to
// the client, and finalize. Interactive PTY sessions are reused across turns to
// avoid paying agy's startup cost for every prompt; one-shot mode remains as a
// compatibility fallback via AGY_PERSISTENT=0.

import {
	type InteractiveAgyOptions,
	InteractiveAgyProcess,
	persistentAgyEnabled,
} from "../agy/interactive";
import { buildAgyArgs, extraArgsFromEnv, spawnAgy } from "../agy/process";
import { POLL_INTERVAL_MS } from "../constants";
import { conversationSnapshot } from "../conversation/scan";
import { StreamPoller } from "../conversation/streaming";
import type { Session } from "../types/session";
import type { AcpClient } from "./client";

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PromptOutcome {
	stopReason: "end_turn" | "cancelled";
	conversationId: string | null;
	lastStepIdx: number;
	hadUpdates: boolean;
	/** Set when agy failed to start, or failed before anything was streamed. */
	error?: string;
}

export interface AdapterConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	skipNarration: boolean;
}

export class Adapter {
	private readonly oneShotChildren = new Map<string, Bun.Subprocess>();
	private readonly interactive = new Map<string, InteractiveAgyProcess>();
	private readonly cancelled = new Set<string>();
	private readonly inFlight = new Set<string>();

	constructor(private readonly config: AdapterConfig) {}

	/** Request cancellation of an in-flight prompt for a session. */
	cancel(sessionId: string): void {
		this.cancelled.add(sessionId);
		this.interactive.get(sessionId)?.cancelTurn();

		const child = this.oneShotChildren.get(sessionId);
		if (!child) return;
		// SIGINT allows agy to flush its DB before exiting; Windows has no real
		// SIGINT for detached children, so Bun falls back to terminating it.
		if (process.platform === "win32") {
			child.kill();
		} else {
			child.kill("SIGINT");
		}
	}

	/** Close and forget a session runtime. Persisted ACP session state is untouched. */
	async close(sessionId: string): Promise<void> {
		this.cancel(sessionId);
		const runtime = this.interactive.get(sessionId);
		this.interactive.delete(sessionId);
		if (runtime) await runtime.close();
		this.cancelled.delete(sessionId);
	}

	/** Run one prompt turn, reusing an interactive agy process when available. */
	async runPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
	): Promise<PromptOutcome> {
		if (this.inFlight.has(sessionId)) {
			return this.errorOutcome(
				session,
				"a prompt is already running for this session",
			);
		}

		this.inFlight.add(sessionId);
		this.cancelled.delete(sessionId);
		try {
			return persistentAgyEnabled()
				? await this.runInteractivePrompt(
						sessionId,
						session,
						promptText,
						client,
					)
				: await this.runOneShotPrompt(sessionId, session, promptText, client);
		} finally {
			this.inFlight.delete(sessionId);
		}
	}

	private async runInteractivePrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
	): Promise<PromptOutcome> {
		const effectiveCwd = session.cwd || this.config.workingDir;
		const snapshot =
			session.conversationId === null
				? conversationSnapshot(this.config.conversationsDir)
				: null;
		const options: InteractiveAgyOptions = {
			binary: this.config.binary,
			workingDir: effectiveCwd,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			permissionMode: session.permissionMode,
			extraArgs: extraArgsFromEnv(),
		};

		let runtime = this.interactive.get(sessionId);
		if (runtime && !runtime.isCompatible(options)) {
			await runtime.close();
			this.interactive.delete(sessionId);
			runtime = undefined;
		}
		if (!runtime) {
			runtime = new InteractiveAgyProcess(options);
			this.interactive.set(sessionId, runtime);
		}

		const poller = this.createPoller(session, effectiveCwd, snapshot);
		try {
			await this.streamUntil(
				sessionId,
				client,
				poller,
				runtime.runTurn(promptText),
			);
		} catch (error) {
			await runtime.close();
			this.interactive.delete(sessionId);
			const wasCancelled = this.cancelled.delete(sessionId);
			const outcome = this.pollerOutcome(session, poller, wasCancelled);
			if (!wasCancelled && !poller.hadUpdates) {
				outcome.error = `agy failed: ${(error as Error).message}`;
			}
			return outcome;
		}

		const wasCancelled = this.cancelled.delete(sessionId);
		runtime.bindConversation(poller.conversationId);
		return this.pollerOutcome(session, poller, wasCancelled);
	}

	private async runOneShotPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
	): Promise<PromptOutcome> {
		const effectiveCwd = session.cwd || this.config.workingDir;
		const snapshot =
			session.conversationId === null
				? conversationSnapshot(this.config.conversationsDir)
				: null;
		const args = buildAgyArgs({
			workingDir: effectiveCwd,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			permissionMode: session.permissionMode,
			prompt: promptText,
			extraArgs: extraArgsFromEnv(),
		});

		let child: Bun.Subprocess;
		try {
			child = spawnAgy(this.config.binary, args, effectiveCwd);
		} catch (error) {
			return this.errorOutcome(
				session,
				`failed to run agy: ${(error as Error).message}`,
			);
		}
		this.oneShotChildren.set(sessionId, child);

		const stderrPromise = child.stderr
			? new Response(child.stderr as ReadableStream).text()
			: Promise.resolve("");
		const poller = this.createPoller(session, effectiveCwd, snapshot);
		const exitCode = await this.streamUntil(
			sessionId,
			client,
			poller,
			child.exited,
		);
		this.oneShotChildren.delete(sessionId);

		const stderr = (await stderrPromise).trim();
		if (stderr.length > 0) console.error(`[agy-acp] agy stderr: ${stderr}`);
		const wasCancelled = this.cancelled.delete(sessionId);
		const outcome = this.pollerOutcome(session, poller, wasCancelled);
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

	private createPoller(
		session: Session,
		effectiveCwd: string,
		snapshot: Set<string> | null,
	): StreamPoller {
		return new StreamPoller({
			dir: this.config.conversationsDir,
			conversationId: session.conversationId,
			baseStepIdx: session.lastStepIdx,
			skipNarration: this.config.skipNarration,
			cwd: effectiveCwd,
			snapshot,
		});
	}

	/** Poll serially until the supplied process/turn promise settles. */
	private async streamUntil<T>(
		sessionId: string,
		client: AcpClient,
		poller: StreamPoller,
		completion: Promise<T>,
	): Promise<T> {
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
				} catch (error) {
					console.error(`[agy-acp] poll error: ${(error as Error).message}`);
				}
				if (!polling) break;
				await sleep(POLL_INTERVAL_MS);
			}
		})();

		let result: T | undefined;
		let failure: unknown;
		try {
			result = await completion;
		} catch (error) {
			failure = error;
		}
		polling = false;
		await loop;

		// Catch rows flushed immediately after the TUI returns to idle/process exits.
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await pollOnce();
			} catch (error) {
				console.error(
					`[agy-acp] final poll error: ${(error as Error).message}`,
				);
			}
			if (attempt < 2) await sleep(100);
		}
		poller.close();

		if (failure) throw failure;
		return result as T;
	}

	private pollerOutcome(
		session: Session,
		poller: StreamPoller,
		wasCancelled: boolean,
	): PromptOutcome {
		return {
			stopReason: wasCancelled ? "cancelled" : "end_turn",
			conversationId: poller.conversationId ?? session.conversationId,
			lastStepIdx: poller.lastStepIdx,
			hadUpdates: poller.hadUpdates,
		};
	}

	private errorOutcome(session: Session, error: string): PromptOutcome {
		return {
			stopReason: "end_turn",
			conversationId: session.conversationId,
			lastStepIdx: session.lastStepIdx,
			hadUpdates: false,
			error,
		};
	}
}

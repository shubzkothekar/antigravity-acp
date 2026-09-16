// Live streaming poller for an in-flight prompt turn. Holds one open DB handle
// for the turn and drives the shared Translator in "stream" mode, emitting only
// newly-appended agent text and not-yet-sent tool steps on each poll.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { ErrorDetails } from "./columns";
import { ConversationDb, ERROR_MESSAGE_STEP_TYPE } from "./database";
import { newConversationId } from "./scan";
import { Translator } from "./translator";

export interface StreamOptions {
	dir: string;
	/** Bound conversation id, or null to bind the DB agy creates for a fresh prompt. */
	conversationId: string | null;
	/** Highest idx already delivered to the client before this turn. */
	baseStepIdx: number;
	skipNarration: boolean;
	cwd?: string;
	/** Snapshot of conversation ids before the prompt, for binding a new DB. */
	snapshot: Set<string> | null;
}

export class StreamPoller {
	private readonly translator: Translator;
	private db: ConversationDb | null = null;
	private boundId: string | null;
	private _quotaError: ErrorDetails | null = null;

	constructor(private readonly opts: StreamOptions) {
		this.boundId = opts.conversationId;
		this.translator = new Translator({
			mode: "stream",
			skipNarration: opts.skipNarration,
			cwd: opts.cwd,
		});
	}

	get conversationId(): string | null {
		return this.boundId;
	}

	get lastStepIdx(): number {
		return Math.max(this.translator.lastStepIdx, this.opts.baseStepIdx);
	}

	/** agy's first RESOURCE_EXHAUSTED error this turn, if any. */
	get quotaError(): ErrorDetails | null {
		return this._quotaError;
	}

	get hadUpdates(): boolean {
		return this.translator.hadUpdates;
	}

	/** Read steps appended since the turn began and translate the new ones. */
	poll(): SessionUpdate[] {
		if (this.boundId === null && this.opts.snapshot !== null) {
			this.boundId = newConversationId(this.opts.dir, this.opts.snapshot);
		}
		if (this.boundId === null) return [];

		if (this.db === null) {
			this.db = ConversationDb.open(this.opts.dir, this.boundId);
			if (this.db === null) return [];
		}

		const rows = this.db.readAfter(this.opts.baseStepIdx);
		for (const { stepType, error } of rows) {
			if (
				error &&
				stepType === ERROR_MESSAGE_STEP_TYPE &&
				(error.message || error.detail).includes("RESOURCE_EXHAUSTED")
			)
				this._quotaError ??= error;
		}
		return this.translator.translate(rows);
	}

	close(): void {
		this.db?.close();
		this.db = null;
	}
}

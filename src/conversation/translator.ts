// Shared step → ACP update engine for both live streaming and history replay.
//
// Streaming and replay only really differ in how they treat the agent's text
// stream (step type 15):
//
//   • streaming emits the newly-appended slice each poll (text grows in place
//     at a fixed idx), deduping tool steps it has already sent;
//   • replay buffers consecutive agent-text parts and flushes them as one
//     message at each boundary, applying narration filtering across the group.
//
// Everything else — tool calls, titles, user prompts, and the task/permission/
// error enrichment — is identical, so it flows through the same per-step
// dispatcher (`buildUpdatefromStepPayload`). This class owns the one row loop;
// the two modes are just small branches inside it.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { filterNarration, isNarration } from "../narration";
import type { StepRow } from "../types";
import { toolCallId } from "../updates/utils";
import { buildUpdatefromStepPayload } from "./updates";

export type TranslateMode = "stream" | "replay";

export interface TranslatorOptions {
	mode: TranslateMode;
	skipNarration: boolean;
	/** Project working dir, used to render display paths in tool calls. */
	cwd?: string;
}

function agentChunk(text: string): SessionUpdate {
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	};
}

function thoughtChunk(text: string): SessionUpdate {
	return {
		sessionUpdate: "agent_thought_chunk",
		content: { type: "text", text },
	} as SessionUpdate;
}

export class Translator {
	// Streaming: idx -> chars of agent text already emitted (for incremental diff).
	private readonly agentTextLengths = new Map<number, number>();
	// Streaming: idx -> chars of thought text already emitted.
	private readonly thoughtTextLengths = new Map<number, number>();
	// Streaming: tool step indices already emitted (dedup across polls).
	private readonly emittedSteps = new Set<number>();
	// Replay: buffered consecutive agent-text parts, flushed at boundaries.
	private readonly pendingAgentParts: string[] = [];
	// Replay: buffered consecutive thought parts, flushed at boundaries.
	private readonly pendingThoughtParts: string[] = [];

	private _lastTitle: string | null = null;
	private _lastStepIdx = -1;
	private _hadUpdates = false;

	constructor(private readonly opts: TranslatorOptions) {}

	/** Highest step idx seen so far. */
	get lastStepIdx(): number {
		return this._lastStepIdx;
	}

	/** Whether any update has been produced across all batches. */
	get hadUpdates(): boolean {
		return this._hadUpdates;
	}

	/** Translate a batch of rows into ordered ACP updates, advancing state. */
	translate(rows: StepRow[]): SessionUpdate[] {
		const out: SessionUpdate[] = [];
		for (const row of rows) this.translateRow(row, out);
		// Replay groups agent/thought text per batch; a batch ends a message boundary.
		if (this.opts.mode === "replay") {
			this.flushAgentBuffer(out);
			this.flushThoughtBuffer(out);
		}
		if (out.length > 0) this._hadUpdates = true;
		return out;
	}

	private translateRow(row: StepRow, out: SessionUpdate[]): void {
		this._lastStepIdx = Math.max(this._lastStepIdx, row.idx);

		switch (row.stepType) {
			case 15: // agent text / thought chunk
				this.handleAgentText(row, out);
				return;

			case 23: // conversation title
				this.handleTitle(row, out);
				return;

			case 14: // user prompt
				// The streaming client already has its own prompt; only replay re-emits it.
				if (this.opts.mode === "stream") return;
				this.flushAgentBuffer(out);
				this.flushThoughtBuffer(out);
				this.pushDispatched(row, out);
				return;

			default: {
				// Tool calls and lifecycle steps. In replay, a tool call ends the
				// current agent message; in streaming, dedup by idx across polls.
				if (this.opts.mode === "replay") {
					this.flushAgentBuffer(out);
					this.flushThoughtBuffer(out);
				} else if (this.emittedSteps.has(row.idx)) {
					return;
				}
				this.emittedSteps.add(row.idx);
				this.pushDispatched(row, out);
			}
		}
	}

	private pushDispatched(row: StepRow, out: SessionUpdate[]): void {
		const update = buildUpdatefromStepPayload(row, this.opts.cwd);
		if (Array.isArray(update)) {
			out.push(...update);
		} else if (update) {
			out.push(update);
		}
	}

	private handleTitle(row: StepRow, out: SessionUpdate[]): void {
		const title = row.stepPayload.titleUpdate?.title ?? null;
		const blocks = title?.split("\n\n");
		const currentTitle = blocks?.shift() || null;
		if (currentTitle !== this._lastTitle) {
			this._lastTitle = currentTitle;
			out.push({ sessionUpdate: "session_info_update", title: currentTitle });
		}

		if (!blocks || blocks?.filter((b) => b.trim().length > 0).length === 0)
			return;

		out.push({
			sessionUpdate: "tool_call",
			toolCallId: toolCallId(row),
			title: "Think",
			kind: "think",
			status: "completed",
			content: [
				{
					type: "content",
					content: {
						type: "text",
						text: blocks?.join("\n\n") || (currentTitle ?? ""),
					},
				},
			],
		});
		return;
	}

	private handleAgentText(row: StepRow, out: SessionUpdate[]): void {
		const text = row.stepPayload.agentText?.text ?? "";
		const thought = row.stepPayload.agentText?.thought ?? "";

		if (this.opts.mode === "replay") {
			if (text.length > 0) this.pendingAgentParts.push(text);
			if (thought.trim().length > 0) this.pendingThoughtParts.push(thought);
			return;
		}

		// Streaming: emit only the slice appended since the last poll for this idx.
		const emitted = this.agentTextLengths.get(row.idx) ?? 0;
		if (text.length > emitted) {
			this.agentTextLengths.set(row.idx, text.length);
			if (!(this.opts.skipNarration && isNarration(text))) {
				const delta = text.slice(emitted);
				if (delta.length > 0) out.push(agentChunk(delta));
			}
		}

		const thoughtEmitted = this.thoughtTextLengths.get(row.idx) ?? 0;
		if (thought.length > thoughtEmitted) {
			this.thoughtTextLengths.set(row.idx, thought.length);
			const delta = thought.slice(thoughtEmitted);
			if (delta.trim().length > 0) out.push(thoughtChunk(delta));
		}
	}

	private flushAgentBuffer(out: SessionUpdate[]): void {
		if (this.pendingAgentParts.length === 0) return;
		const text = this.opts.skipNarration
			? filterNarration(this.pendingAgentParts)
			: this.pendingAgentParts.join("\n");
		this.pendingAgentParts.length = 0;
		if (text && text.length > 0) out.push(agentChunk(text));
	}

	private flushThoughtBuffer(out: SessionUpdate[]): void {
		if (this.pendingThoughtParts.length === 0) return;
		const text = this.pendingThoughtParts.join("\n");
		this.pendingThoughtParts.length = 0;
		if (text.trim().length > 0) out.push(thoughtChunk(text));
	}
}

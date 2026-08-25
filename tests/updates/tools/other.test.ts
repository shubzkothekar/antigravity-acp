import { describe, expect, test } from "bun:test";
import type { StepRow } from "../../../src/types";
import { otherUpdate } from "../../../src/updates/tools/other";

describe("updates/tools/other.ts", () => {
	describe("otherUpdate()", () => {
		test("handles manage_task", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "manage_task",
							rawInputJson: JSON.stringify({ Action: "status", TaskId: "t1" }),
						},
					},
				},
			} as StepRow;
			const update: any = otherUpdate(step);
			expect(update.title).toBe("Manage task status");
			expect(update.content).toEqual([
				{ type: "content", content: { type: "text", text: "Task: t1" } },
			]);
		});

		test("handles schedule", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "schedule",
							rawInputJson: JSON.stringify({
								DurationSeconds: "100",
								Prompt: "wake up",
							}),
						},
					},
				},
			} as StepRow;
			const update: any = otherUpdate(step);
			expect(update.title).toBe("Schedule timer (100s)");
			expect(update.content).toEqual([
				{ type: "content", content: { type: "text", text: "wake up" } },
			]);
		});

		test("handles send_message", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "send_message",
							rawInputJson: JSON.stringify({ Message: "hello subagent" }),
						},
					},
				},
			} as StepRow;
			const update: any = otherUpdate(step);
			expect(update.title).toBe("Send message to subagent");
			expect(update.content).toEqual([
				{ type: "content", content: { type: "text", text: "hello subagent" } },
			]);
		});

		test("handles manage_subagents", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "manage_subagents",
							rawInputJson: JSON.stringify({ Action: "kill_all" }),
						},
					},
				},
			} as StepRow;
			const update: any = otherUpdate(step);
			expect(update.title).toBe("Subagents: kill_all");
			expect(update.content).toBeUndefined();
		});

		test("fallback stringifies unknown tool payloads", () => {
			const step = {
				stepPayload: {
					toolRun: {
						titlePrimary: "Custom Action",
						call: {
							namePrimary: "unknown_tool",
							rawInputJson: JSON.stringify({
								arg1: "val",
								toolAction: "ignore me",
							}),
						},
					},
				},
			} as StepRow;
			const update: any = otherUpdate(step);
			expect(update.title).toBe("Custom Action");
			expect(update.content).toBeDefined();
			const text = update.content?.[0]?.content?.text;
			expect(text).toContain("arg1");
			expect(text).not.toContain("toolAction");
		});

		test("fallback prefers toolOutput when available", () => {
			const step = {
				stepPayload: {
					toolRun: {
						titlePrimary: "Custom Action",
						call: {
							namePrimary: "unknown_tool",
							rawInputJson: JSON.stringify({ arg1: "val" }),
						},
					},
				},
				toolOutput: "Custom tool executed successfully",
			} as StepRow;
			const update: any = otherUpdate(step);
			expect(update.title).toBe("Custom Action");
			expect(update.content).toEqual([
				{
					type: "content",
					content: {
						type: "text",
						text: "```\nCustom tool executed successfully\n```",
					},
				},
			]);
		});
	});
});

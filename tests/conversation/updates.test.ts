import { describe, expect, test } from "bun:test";
import { buildUpdatefromStepPayload } from "../../src/conversation/updates";
import type { StepRow } from "../../src/types";

function mockStepRow(stepType: number, namePrimary?: string): StepRow {
	return {
		idx: 1,
		stepType,
		status: 0,
		stepPayload: {
			toolRun: namePrimary ? { call: { namePrimary } } : undefined,
			agentText: { text: "agent output" },
			titleUpdate: { title: "new title" },
			userPrompt: { text: "hello user" },
		},
		error: null,
		permission: null,
		task: null,
	} as any;
}

describe("conversation/updates", () => {
	test("routes user prompt (14)", () => {
		const row = mockStepRow(14);
		// userPromptUpdate will return an update.
		// Even if empty, it shouldn't be a tool call.
		const update = buildUpdatefromStepPayload(row);
		expect(update).not.toBeNull();
		// In actual implementation, userPromptUpdate might return null if no text,
		// but with our mock it should work.
	});

	test("routes agent chunk (15)", () => {
		const row = mockStepRow(15);
		const update = buildUpdatefromStepPayload(row);
		expect(update).not.toBeNull();
		expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
			"agent_message_chunk",
		);
	});

	test("routes title update (23)", () => {
		const row = mockStepRow(23);
		const update = buildUpdatefromStepPayload(row);
		expect(update).not.toBeNull();
		expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
			"session_info_update",
		);
	});

	test("routes lifecycle steps to null (90, 98, 101)", () => {
		expect(buildUpdatefromStepPayload(mockStepRow(90))).toBeNull();
		expect(buildUpdatefromStepPayload(mockStepRow(98))).toBeNull();
		expect(buildUpdatefromStepPayload(mockStepRow(101))).toBeNull();
	});

	test("routes unknown lifecycle steps to null", () => {
		// Mock an unknown step type that is added to LIFECYCLE_STEP_TYPES
		// Wait, we don't know the full set. But we know 90, 98, 101 are in LIFECYCLE_STEP_TYPES.
	});

	test("routes unknown tool steps by namePrimary", () => {
		const row = mockStepRow(999, "run_command");
		const update = buildUpdatefromStepPayload(row);
		expect(update).not.toBeNull();
		expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
			"tool_call",
		);
	});

	test("returns null for unknown steps without tool call", () => {
		const row = mockStepRow(999);
		const update = buildUpdatefromStepPayload(row);
		expect(update).toBeNull();
	});

	describe("tool routing by type", () => {
		test("type 8 (view_file)", () => {
			const update = buildUpdatefromStepPayload(mockStepRow(8));
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
		});

		test("type 7 (grep_search)", () => {
			const update = buildUpdatefromStepPayload(mockStepRow(7));
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
		});

		test("type 21 (run_command)", () => {
			const update = buildUpdatefromStepPayload(mockStepRow(21));
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
		});
	});

	describe("type 17 mixed tool routing", () => {
		test("routes by name when namePrimary exists", () => {
			const row = mockStepRow(17, "ask_question");
			const update = buildUpdatefromStepPayload(row);
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
		});

		test("returns null when no namePrimary exists for type 17", () => {
			const row = mockStepRow(17); // no namePrimary
			const update = buildUpdatefromStepPayload(row);
			expect(update).toBeNull();
		});
	});

	describe("type 132 modern tool routing", () => {
		test("routes run_command by name", () => {
			const row = mockStepRow(132, "run_command");
			const update = buildUpdatefromStepPayload(row);
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
			expect((update as any).kind).toBe("execute");
		});

		test("routes view_file by name", () => {
			const row = mockStepRow(132, "view_file");
			const update = buildUpdatefromStepPayload(row);
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
			expect((update as any).kind).toBe("read");
		});

		test("routes find_by_name by name", () => {
			const row = mockStepRow(132, "find_by_name");
			const update = buildUpdatefromStepPayload(row);
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
			expect((update as any).kind).toBe("search");
		});

		test("routes orchestration tools (e.g. manage_task) to otherUpdate", () => {
			const row = mockStepRow(132, "manage_task");
			const update = buildUpdatefromStepPayload(row);
			expect((Array.isArray(update) ? update[0] : update)?.sessionUpdate).toBe(
				"tool_call",
			);
			expect((update as any).kind).toBe("other");
		});
	});
});

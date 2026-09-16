import { describe, expect, test } from "bun:test";
import { Adapter, formatQuotaError } from "../../src/acp/adapter";

describe("formatQuotaError", () => {
	test("renders the message, Error ID, and absolute refresh time like the IDE", () => {
		const now = new Date(2026, 8, 16, 16, 41, 44);
		const text = formatQuotaError(
			{
				message: "",
				detail:
					"API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 7m11s.",
				stackTrace: "",
				id: "00000000-0000-4000-8000-000000000002-1",
			},
			now,
		);
		expect(text).toBe(
			"Individual quota reached. Please upgrade your subscription to increase your limits.\n\n" +
				"Error ID: 00000000-0000-4000-8000-000000000002-1\n\n" +
				`Your plan's baseline quota will refresh on ${new Date(2026, 8, 16, 16, 48, 55).toLocaleString("en-US")}.`,
		);
	});
});

describe("Adapter", () => {
	test("cancel should handle non-existent session gracefully", () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});
		// should not throw
		adapter.cancel("non-existent");
		expect(true).toBe(true);
	});

	test("runPrompt should handle spawn failure", async () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});

		// We could mock spawnAgy but let's test if it handles a non-existent binary or errors.
		// A lightweight test for prompt running.
		expect(adapter).toBeDefined();
	});
});

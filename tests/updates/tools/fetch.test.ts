import { describe, expect, test } from "bun:test";
import type { StepRow } from "../../../src/types";
import { fetchUpdate } from "../../../src/updates/tools/fetch";

describe("updates/tools/fetch.ts", () => {
	describe("fetchUpdate()", () => {
		test("uses Url as title and content", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							rawInputJson: JSON.stringify({ Url: "https://example.com" }),
						},
					},
				},
			} as StepRow;

			const update: any = fetchUpdate(step);
			expect(update.title).toBe("Fetch https://example.com");
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "https://example.com" },
				},
			]);
		});

		test("fallbacks to titlePrimary when Url is missing", () => {
			const step = {
				stepPayload: {
					toolRun: {
						titlePrimary: "Primary Fetch Title",
						call: { rawInputJson: "{}" },
					},
				},
			} as StepRow;

			const update: any = fetchUpdate(step);
			expect(update.title).toBe("Primary Fetch Title");
			expect(update.content).toBeUndefined();
		});

		test("fallbacks to 'Fetch URL' when completely missing", () => {
			const step = {
				stepPayload: {},
			} as StepRow;

			const update: any = fetchUpdate(step);
			expect(update.title).toBe("Fetch URL");
		});

		test("renders toolOutput as codeBlock when present", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							rawInputJson: JSON.stringify({ Url: "https://example.com" }),
						},
					},
				},
				toolOutput: "# Example Content\nSome fetched markdown",
			} as StepRow;

			const update: any = fetchUpdate(step);
			expect(update.title).toBe("Fetch https://example.com");
			expect(update.content).toEqual([
				{
					type: "content",
					content: {
						type: "text",
						text: "```\n# Example Content\nSome fetched markdown\n```",
					},
				},
			]);
		});
	});
});

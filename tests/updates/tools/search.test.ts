import { describe, expect, test } from "bun:test";
import type { StepRow } from "../../../src/types";
import { searchUpdate } from "../../../src/updates/tools/search";

describe("updates/tools/search.ts", () => {
	describe("searchUpdate()", () => {
		test("grep_search uses hits primarily if available", () => {
			const step = {
				stepType: 7,
				stepPayload: {
					toolRun: { call: { rawInputJson: JSON.stringify({ Query: "foo" }) } },
					grepSearch: {
						query: "foo",
						cwdUri: "file:///a/b",
						hits: [{ field1: "file1", field2: "1", field3: "foo()" }],
					},
				},
			} as unknown as StepRow;

			const update: any = searchUpdate(step, "/a");
			expect(update.title).toBe("Search 'foo' b");
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\nfile1 | 1 | foo()\n```" },
				},
			]);
			expect(update.locations).toEqual([{ path: "/a/b" }]);
		});

		test("grep_search prioritizes textOutput over hits", () => {
			const step = {
				stepType: 7,
				stepPayload: {
					toolRun: { call: { rawInputJson: JSON.stringify({ Query: "foo" }) } },
					grepSearch: {
						textOutput: "raw text",
						hits: [{ field1: "file1" }],
					},
				},
			} as unknown as StepRow;

			const update: any = searchUpdate(step);
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\nraw text\n```" },
				},
			]);
		});

		test("grep_search uses shellCommand if hits and text are empty", () => {
			const step = {
				stepType: 7,
				stepPayload: {
					toolRun: { call: { rawInputJson: JSON.stringify({ Query: "foo" }) } },
					grepSearch: {
						shellCommand: "git grep foo",
					},
				},
			} as unknown as StepRow;

			const update: any = searchUpdate(step);
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\ngit grep foo\n```" },
				},
			]);
		});

		test("search_web ignores body and sets query in title", () => {
			const step = {
				stepType: 33,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "search_web",
							rawInputJson: JSON.stringify({ query: "how to bun" }),
						},
					},
				},
			} as StepRow;

			const update: any = searchUpdate(step);
			expect(update.title).toBe("Web search how to bun");
			expect(update.content).toBeUndefined();
		});

		test("search_web renders toolOutput when available", () => {
			const step = {
				stepType: 132,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "search_web",
							rawInputJson: JSON.stringify({ query: "bun test" }),
						},
					},
				},
				toolOutput: "Search results for bun test...",
			} as StepRow;

			const update: any = searchUpdate(step);
			expect(update.title).toBe("Web search bun test");
			expect(update.content).toEqual([
				{
					type: "content",
					content: {
						type: "text",
						text: "```\nSearch results for bun test...\n```",
					},
				},
			]);
		});

		test("find_by_name extracts pattern and directory", () => {
			const step = {
				stepType: 132,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "find_by_name",
							rawInputJson: JSON.stringify({
								Pattern: "*.ts",
								SearchDirectory: "/a/src",
							}),
						},
					},
				},
				toolOutput: "src/index.ts\nsrc/utils.ts",
			} as StepRow;

			const update: any = searchUpdate(step, "/a");
			expect(update.title).toBe("Search '*.ts' src");
			expect(update.content).toEqual([
				{
					type: "content",
					content: {
						type: "text",
						text: "```\nsrc/index.ts\nsrc/utils.ts\n```",
					},
				},
			]);
			expect(update.locations).toEqual([{ path: "/a/src" }]);
		});
	});
});

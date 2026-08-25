import { describe, expect, test } from "bun:test";
import type { StepRow } from "../../../src/types";
import { readUpdate } from "../../../src/updates/tools/read";

describe("updates/tools/read.ts", () => {
	describe("readUpdate()", () => {
		test("list_dir uses native protobuf decoder", () => {
			const step = {
				stepType: 9,
				stepPayload: {
					toolRun: { call: { rawInputJson: "{}" } },
					listDirectory: {
						dirUri: "file:///a/b",
						entries: [
							{ name: "src", isDirectory: 1 },
							{ name: "file.txt", isDirectory: 0 },
						],
					},
				},
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read b");
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\nsrc/\nfile.txt\n```" },
				},
			]);
			expect(update.locations).toEqual([{ path: "/a/b" }]);
		});

		test("list_dir fallbacks to raw input if protobuf missing", () => {
			const step = {
				stepType: 9,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "list_dir",
							rawInputJson: JSON.stringify({ DirectoryPath: "/a/b" }),
						},
					},
				},
			} as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read b");
			expect(update.content).toBeUndefined();
		});

		test("view_file uses native protobuf decoder with range", () => {
			const step = {
				stepType: 8,
				stepPayload: {
					toolRun: { call: { rawInputJson: "{}" } },
					viewFile: {
						fileUri: "file:///a/b.txt",
						startLine: 5,
						endLine: 10,
						content: "lines 5 to 10",
					},
				},
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read b.txt:5-10");
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\nlines 5 to 10\n```" },
				},
			]);
			expect(update.locations).toEqual([{ path: "/a/b.txt", line: 5 }]);
		});

		test("view_file prefers raw input absolute path", () => {
			const step = {
				stepType: 8,
				stepPayload: {
					toolRun: {
						call: {
							rawInputJson: JSON.stringify({ AbsolutePath: "/a/c.txt" }),
						},
					},
					viewFile: {
						fileUri: "file:///a/b.txt",
					},
				},
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read c.txt");
			expect(update.locations).toEqual([{ path: "/a/c.txt", line: 1 }]);
		});

		test("view_file uses toolOutput when protobuf viewFile content is absent", () => {
			const step = {
				stepType: 132,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "view_file",
							rawInputJson: JSON.stringify({ AbsolutePath: "/a/code.ts" }),
						},
					},
				},
				toolOutput: "export const answer = 42;",
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read code.ts");
			expect(update.content).toEqual([
				{
					type: "content",
					content: {
						type: "text",
						text: "```\nexport const answer = 42;\n```",
					},
				},
			]);
		});

		test("list_dir uses toolOutput when entries is absent", () => {
			const step = {
				stepType: 132,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "list_dir",
							rawInputJson: JSON.stringify({ DirectoryPath: "/a/dir" }),
						},
					},
				},
				toolOutput: "file1.ts\nfile2.ts",
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read dir");
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\nfile1.ts\nfile2.ts\n```" },
				},
			]);
		});
	});
});

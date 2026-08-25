import { describe, expect, test } from "bun:test";
import type { StepRow } from "../../../src/types";
import { executeUpdate } from "../../../src/updates/tools/execute";
import { codeBlock } from "../../../src/updates/utils";

describe("updates/tools/execute.ts", () => {
	describe("executeUpdate()", () => {
		test("extracts single line command as title and block", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							rawInputJson: JSON.stringify({
								CommandLine: "echo hello",
								Cwd: "/a/b",
							}),
						},
					},
				},
			} as StepRow;

			const update: any = executeUpdate(step);
			expect(update.title).toBe("echo hello");
			expect(update.content).toEqual([codeBlock("echo hello")]);
			expect(update.locations).toEqual([{ path: "/a/b" }]);
		});

		test("extracts first line of multiline command as title", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							rawInputJson: JSON.stringify({
								CommandLine: "echo hello\necho world",
							}),
						},
					},
				},
			} as StepRow;

			const update: any = executeUpdate(step);
			expect(update.title).toBe("echo hello");
			expect(update.content).toEqual([codeBlock("echo hello\necho world")]);
		});

		test("fallbacks to toolRun titles when CommandLine is missing", () => {
			const step = {
				stepPayload: {
					toolRun: {
						titlePrimary: "Fallback Title",
						call: { rawInputJson: "{}" },
					},
				},
			} as StepRow;

			const update: any = executeUpdate(step);
			expect(update.title).toBe("Fallback Title");
			expect(update.content).toBeUndefined();
		});

		test("renders toolOutput as content and rawOutput when available", () => {
			const step = {
				stepPayload: {
					toolRun: {
						call: {
							rawInputJson: JSON.stringify({
								CommandLine: "ls -la",
								Cwd: "/workspace",
							}),
						},
					},
				},
				toolOutput: "total 0\n-rw-r--r-- 1 user user 0 file.txt",
			} as StepRow;

			const update: any = executeUpdate(step);
			expect(update.title).toBe("ls -la");
			expect(update.content).toEqual([
				codeBlock("total 0\n-rw-r--r-- 1 user user 0 file.txt"),
			]);
			expect(update.rawOutput).toEqual({
				output: "total 0\n-rw-r--r-- 1 user user 0 file.txt",
			});
		});
	});
});

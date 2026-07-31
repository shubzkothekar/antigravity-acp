import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	buildAgyArgs,
	discoverModels,
	extraArgsFromEnv,
	spawnAgy,
} from "../../src/agy/process";
import * as procUtils from "../../src/utils/process";

describe("agy/process.ts", () => {
	afterEach(() => {
		mock.restore();
		delete process.env.AGY_EXTRA_ARGS;
	});

	describe("discoverModels()", () => {
		it("should return condensed models on success (exit code 0)", async () => {
			const mockCapture = spyOn(procUtils, "runCapture").mockResolvedValue({
				exitCode: 0,
				stdout:
					"model-1-high Model One (High)\nmodel-1-low Model One (Low)\nmodel-2 Model Two\n",
				stderr: "",
			});

			const models = await discoverModels("dummy-binary");
			expect(mockCapture).toHaveBeenCalledWith("dummy-binary", ["models"]);
			expect(models.map((m) => m.id)).toEqual(["model-1", "model-2"]);
			expect(models[0]?.variants).toEqual({
				high: "model-1-high",
				low: "model-1-low",
			});
		});

		it("should return empty array on non-zero exit code", async () => {
			spyOn(procUtils, "runCapture").mockResolvedValue({
				exitCode: 1,
				stdout: "model-1\nmodel-2",
				stderr: "",
			});

			const models = await discoverModels("dummy-binary");
			expect(models).toEqual([]);
		});

		it("should return empty array when spawn throws an exception", async () => {
			spyOn(procUtils, "runCapture").mockRejectedValue(
				new Error("spawn failed"),
			);

			const models = await discoverModels("dummy-binary");
			expect(models).toEqual([]);
		});
	});

	describe("buildAgyArgs()", () => {
		it("should build basic args with default effort", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--effort",
				"medium",
				"-p",
				"hello",
			]);
		});

		it("should add additionalDirs", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				additionalDirs: ["/dir1", "/dir2"],
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--add-dir",
				"/dir1",
				"--add-dir",
				"/dir2",
				"--effort",
				"medium",
				"-p",
				"hello",
			]);
		});

		it("should add extraArgs", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				extraArgs: ["--foo", "bar"],
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--foo",
				"bar",
				"--effort",
				"medium",
				"-p",
				"hello",
			]);
		});

		it("should add conversationId and resolve modelId + effort", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: "conv-1",
				modelId: "gemini-3.6-flash",
				models: [
					{
						id: "gemini-3.6-flash",
						name: "Gemini 3.6 Flash",
						variants: {
							high: "gemini-3.6-flash-high",
							medium: "gemini-3.6-flash-medium",
							low: "gemini-3.6-flash-low",
						},
						fixedIds: [],
					},
				],
				effort: "high",
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--conversation",
				"conv-1",
				"--model",
				"gemini-3.6-flash-high",
				"--effort",
				"high",
				"-p",
				"hello",
			]);
		});

		it("should synthesize backend model id when catalog is empty", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: "model-1",
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toContain("--model");
			expect(args).toContain("model-1-medium");
		});

		it("should expand plan mode + effort", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "plan",
				effort: "high",
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--mode",
				"plan",
				"--effort",
				"high",
				"-p",
				"hello",
			]);
		});

		it("should pass accept-edits mode", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "accept-edits",
				prompt: "hello",
			});
			expect(args).toContain("--mode");
			expect(args).toContain("accept-edits");
			expect(args).not.toContain("--sandbox");
			expect(args).not.toContain("--dangerously-skip-permissions");
		});

		it("should map sandbox mode to --sandbox", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "sandbox",
				prompt: "hello",
			});
			expect(args).toContain("--sandbox");
			expect(args).not.toContain("--mode");
			expect(args).not.toContain("--dangerously-skip-permissions");
		});

		it("should map accept-tools (and legacy aliases) to skip-permissions only", () => {
			for (const mode of [
				"accept-tools",
				"bypassPermissions",
				"bypass",
				"dontAsk",
			]) {
				const args = buildAgyArgs({
					workingDir: "/cwd",
					conversationId: null,
					modelId: null,
					permissionMode: mode,
					prompt: "hello",
				});
				expect(args).toContain("--dangerously-skip-permissions");
				expect(args).not.toContain("--mode");
			}
		});

		it("should map accept-edits-tools (and legacy) to mode + skip-permissions", () => {
			for (const mode of ["accept-edits-tools", "accept-edits-unsafe"]) {
				const args = buildAgyArgs({
					workingDir: "/cwd",
					conversationId: null,
					modelId: null,
					permissionMode: mode,
					prompt: "hello",
				});
				expect(args).toContain("--mode");
				expect(args).toContain("accept-edits");
				expect(args).toContain("--dangerously-skip-permissions");
				expect(args).not.toContain("--sandbox");
			}
		});

		it("should still honor legacy explicit sandbox/skip flags", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "default",
				sandbox: true,
				skipPermissions: true,
				prompt: "hello",
			});
			expect(args).toContain("--sandbox");
			expect(args).toContain("--dangerously-skip-permissions");
		});

		it("should not skip permissions for unknown modes", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "ask",
				prompt: "hello",
			});
			expect(args).not.toContain("--dangerously-skip-permissions");
			expect(args).not.toContain("--sandbox");
		});
	});

	describe("spawnAgy()", () => {
		it("should spawn agy with expected config", () => {
			const mockSpawn = spyOn(procUtils, "spawnProcess").mockReturnValue({
				exited: Promise.resolve(0),
				stderr: null,
				kill: () => true,
			} as any);
			spawnAgy("my-agy", ["--foo", "bar"], "/some/cwd");

			expect(mockSpawn).toHaveBeenCalledWith("my-agy", ["--foo", "bar"], {
				cwd: "/some/cwd",
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			});
		});
	});

	describe("extraArgsFromEnv()", () => {
		it("should return empty array if env is not set", () => {
			expect(extraArgsFromEnv()).toEqual([]);
		});

		it("should securely split shell variables with irregular spacing", () => {
			process.env.AGY_EXTRA_ARGS = "  --foo   bar   --baz\t qux \n ";
			expect(extraArgsFromEnv()).toEqual(["--foo", "bar", "--baz", "qux"]);
		});
	});
});

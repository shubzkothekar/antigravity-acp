import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	MAX_PROMPT_ARG_LENGTH,
	buildAgyArgs,
	discoverModels,
	extraArgsFromEnv,
	preparePromptArg,
	spawnAgy,
} from "../../src/agy/process";

describe("agy/process.ts", () => {
	afterEach(() => {
		mock.restore();
		delete process.env.AGY_EXTRA_ARGS;
	});

	describe("discoverModels()", () => {
		it("should return model ids on success (exit code 0)", async () => {
			const mockSpawn = spyOn(Bun, "spawn").mockReturnValue({
				stdout: "model-1\nmodel-2\n  model-3  \n\n",
				exited: Promise.resolve(0),
			} as any);

			const models = await discoverModels("dummy-binary");
			expect(mockSpawn).toHaveBeenCalledWith(["dummy-binary", "models"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			expect(models).toEqual([
				{ value: "model-1", name: "model-1" },
				{ value: "model-2", name: "model-2" },
				{ value: "model-3", name: "model-3" },
			]);
		});

		it("should return empty array on non-zero exit code", async () => {
			spyOn(Bun, "spawn").mockReturnValue({
				stdout: "model-1\nmodel-2",
				exited: Promise.resolve(1),
			} as any);

			const models = await discoverModels("dummy-binary");
			expect(models).toEqual([]);
		});

		it("should return empty array when spawn throws an exception", async () => {
			spyOn(Bun, "spawn").mockImplementation(() => {
				throw new Error("spawn failed");
			});

			const models = await discoverModels("dummy-binary");
			expect(models).toEqual([]);
		});
	});

	describe("buildAgyArgs()", () => {
		it("should build basic args with default accept-edits mode", () => {
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
				"--mode",
				"accept-edits",
				"--dangerously-skip-permissions",
				"--print-timeout",
				"0",
				"-p",
				"hello",
			]);
		});

		it("adds the session's MCP plugin folder as one more --add-dir", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				additionalDirs: ["/dir1"],
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
				mcpRoot: "/state/mcp-sessions/1-s1",
			});
			expect(args.slice(0, 6)).toEqual([
				"--add-dir",
				"/cwd",
				"--add-dir",
				"/dir1",
				"--add-dir",
				"/state/mcp-sessions/1-s1",
			]);
		});

		it("adds no extra --add-dir without an MCP plugin folder", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
				mcpRoot: null,
			});
			expect(args.filter((a) => a === "--add-dir")).toHaveLength(1);
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
				"--mode",
				"accept-edits",
				"--dangerously-skip-permissions",
				"--print-timeout",
				"0",
				"-p",
				"hello",
			]);
		});

		it("should add extraArgs at the end to allow overriding preceding flags", () => {
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
				"--mode",
				"accept-edits",
				"--dangerously-skip-permissions",
				"--print-timeout",
				"0",
				"--foo",
				"bar",
				"-p",
				"hello",
			]);
		});

		it("should allow extraArgs to override print-timeout or other options", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				extraArgs: ["--print-timeout", "10m"],
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--mode",
				"accept-edits",
				"--dangerously-skip-permissions",
				"--print-timeout",
				"0",
				"--print-timeout",
				"10m",
				"-p",
				"hello",
			]);
		});

		it("should add conversationId and modelId", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: "conv-1",
				modelId: "model-1",
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--conversation",
				"conv-1",
				"--model",
				"model-1",
				"--mode",
				"accept-edits",
				"--dangerously-skip-permissions",
				"--print-timeout",
				"0",
				"-p",
				"hello",
			]);
		});

		it("should set --mode plan when permissionMode is plan", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "plan",
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--mode",
				"plan",
				"--dangerously-skip-permissions",
				"--print-timeout",
				"0",
				"-p",
				"hello",
			]);
		});

		it("should add --sandbox when sandbox is true", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: null,
				sandbox: true,
				prompt: "hello",
			});
			expect(args).toEqual([
				"--add-dir",
				"/cwd",
				"--mode",
				"accept-edits",
				"--dangerously-skip-permissions",
				"--sandbox",
				"--print-timeout",
				"0",
				"-p",
				"hello",
			]);
		});

		it("should omit --sandbox when sandbox is false or omitted", () => {
			const argsFalse = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: null,
				sandbox: false,
				prompt: "hello",
			});
			expect(argsFalse).not.toContain("--sandbox");

			const argsOmitted = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
			});
			expect(argsOmitted).not.toContain("--sandbox");
		});

		it("should always skip permissions regardless of mode", () => {
			const argsPlan = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "plan",
				prompt: "hello",
			});
			expect(argsPlan).toContain("--dangerously-skip-permissions");

			const argsDefault = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: "default",
				prompt: "hello",
			});
			expect(argsDefault).toContain("--dangerously-skip-permissions");

			const argsNullMode = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
			});
			expect(argsNullMode).toContain("--dangerously-skip-permissions");
		});
	});

	describe("spawnAgy()", () => {
		it("should spawn agy with expected config", () => {
			const mockSpawn = spyOn(Bun, "spawn").mockReturnValue({} as any);
			spawnAgy("my-agy", ["--foo", "bar"], "/some/cwd");

			expect(mockSpawn).toHaveBeenCalledWith(["my-agy", "--foo", "bar"], {
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

	describe("preparePromptArg()", () => {
		it("should keep normal prompts unchanged", () => {
			const res = preparePromptArg("short prompt");
			expect(res.promptArg).toBe("short prompt");
			expect(res.tempFilePath).toBeUndefined();
		});

		it("should offload oversized prompts to a temporary file", () => {
			const huge = "A".repeat(MAX_PROMPT_ARG_LENGTH + 100);
			const res = preparePromptArg(huge, "test-session");
			expect(res.tempFilePath).toBeDefined();
			expect(res.promptArg).toContain("Please read the prompt and context in");
			expect(res.promptArg).toContain(res.tempFilePath!);
			
			// Verify file content
			const content = require("node:fs").readFileSync(res.tempFilePath!, "utf-8");
			expect(content).toBe(huge);

			// Clean up
			require("node:fs").unlinkSync(res.tempFilePath!);
		});
	});
});

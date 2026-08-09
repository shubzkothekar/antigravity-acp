import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	buildAgyArgs,
	discoverModels,
	extraArgsFromEnv,
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
		it("should build basic args", () => {
			const args = buildAgyArgs({
				workingDir: "/cwd",
				conversationId: null,
				modelId: null,
				permissionMode: null,
				prompt: "hello",
			});
			expect(args).toEqual(["--add-dir", "/cwd", "-p", "hello"]);
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
				"-p",
				"hello",
			]);
		});

		it("should handle bypass permission modes", () => {
			for (const mode of ["bypassPermissions", "bypass", "dontAsk"]) {
				const args = buildAgyArgs({
					workingDir: "/cwd",
					conversationId: null,
					modelId: null,
					permissionMode: mode,
					prompt: "hello",
				});
				expect(args).toContain("--dangerously-skip-permissions");
			}
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
});

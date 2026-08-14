import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGY_PROCESS_PROXY_FLAG,
	buildAgyArgs,
	discoverModels,
	extraArgsFromEnv,
	runAgyProcessProxy,
	spawnAgy,
} from "../../src/agy/process";

function encodeProxyRequest(request: {
	binary: string;
	args: string[];
	cwd: string;
}): string {
	return Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
}

function requestFromProxyCommand(command: string[]) {
	const flagIndex = command.indexOf(AGY_PROCESS_PROXY_FLAG);
	expect(flagIndex).toBeGreaterThan(0);
	return JSON.parse(
		Buffer.from(command[flagIndex + 1] as string, "base64url").toString("utf8"),
	);
}

describe("agy/process.ts", () => {
	let lockDir: string;

	beforeEach(() => {
		lockDir = mkdtempSync(join(tmpdir(), "agy-acp-process-lock-"));
		process.env.AGY_ACP_LOCK_FILE = join(lockDir, "agy.lock");
		process.env.AGY_ACP_PROXY_ENTRYPOINT = join(
			import.meta.dir,
			"../../index.ts",
		);
	});

	afterEach(() => {
		mock.restore();
		delete process.env.AGY_EXTRA_ARGS;
		delete process.env.AGY_ACP_LOCK_FILE;
		delete process.env.AGY_ACP_PROXY_ENTRYPOINT;
		rmSync(lockDir, { recursive: true, force: true });
	});

	describe("discoverModels()", () => {
		it("should return model ids on success (exit code 0)", async () => {
			const mockSpawn = spyOn(Bun, "spawn").mockReturnValue({
				stdout: "model-1\nmodel-2\n  model-3  \n\n",
				exited: Promise.resolve(0),
			} as any);

			const models = await discoverModels("dummy-binary");
			const [command, options] = mockSpawn.mock.calls[0]!;
			expect(requestFromProxyCommand(command as string[])).toEqual({
				binary: "dummy-binary",
				args: ["models"],
				cwd: process.cwd(),
			});
			expect(options).toEqual({
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			expect(models).toEqual(["model-1", "model-2", "model-3"]);
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
		it("routes agy through the process proxy", async () => {
			const markerFile = join(lockDir, "agy-launched");
			const child = await spawnAgy(
				process.execPath,
				[join(import.meta.dir, "../fixtures/record-agy-launch.ts"), markerFile],
				process.cwd(),
				undefined,
				() => expect(existsSync(markerFile)).toBe(false),
			);
			expect(await child.exited).toBe(0);
			expect(existsSync(markerFile)).toBe(true);
		});

		it("surfaces proxy spawn failures through the public path", async () => {
			const missingBinary = join(lockDir, "missing-agy");
			await expect(
				spawnAgy(missingBinary, ["prompt"], process.cwd()),
			).rejects.toThrow(missingBinary);
		});

		it("serializes concurrent agy processes", async () => {
			let finishFirst: (exitCode: number) => void = () => {};
			const firstExited = new Promise<number>((resolve) => {
				finishFirst = resolve;
			});
			let spawnCount = 0;
			spyOn(Bun, "spawn").mockImplementation(() => {
				spawnCount += 1;
				return {
					exited: spawnCount === 1 ? firstExited : Promise.resolve(0),
				} as any;
			});

			const first = runAgyProcessProxy(
				encodeProxyRequest({
					binary: "my-agy",
					args: ["first"],
					cwd: "/some/cwd",
				}),
			);
			const second = runAgyProcessProxy(
				encodeProxyRequest({
					binary: "my-agy",
					args: ["second"],
					cwd: "/some/cwd",
				}),
			);

			const stateBeforeFirstExit = await Promise.race([
				Promise.resolve(second).then(() => "spawned"),
				Bun.sleep(10).then(() => "waiting"),
			]);
			expect(stateBeforeFirstExit).toBe("waiting");

			finishFirst(0);
			await Promise.all([first, second]);
			expect(spawnCount).toBe(2);
		});

		it("does not spawn a proxy when start is already cancelled", async () => {
			const mockSpawn = spyOn(Bun, "spawn");
			const controller = new AbortController();
			controller.abort();

			await expect(
				spawnAgy("my-agy", ["cancelled"], "/some/cwd", controller.signal),
			).rejects.toBeInstanceOf(Error);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("rejects when the proxy exits without a handshake signal", async () => {
			process.env.AGY_ACP_PROXY_ENTRYPOINT = join(
				import.meta.dir,
				"../fixtures/silent-proxy.ts",
			);
			const started = performance.now();
			await expect(
				spawnAgy(process.execPath, ["prompt"], process.cwd()),
			).rejects.toThrow(/locked signal/);
			// The exit race must resolve it, not an open-ended wait on the pipe.
			expect(performance.now() - started).toBeLessThan(2000);
		});

		it("retries when the proxy self-cancels during the handshake", async () => {
			const markerFile = join(lockDir, "agy-launched");
			process.env.AGY_ACP_PROXY_ENTRYPOINT = join(
				import.meta.dir,
				"../fixtures/flaky-proxy.ts",
			);
			process.env.AGY_ACP_FLAKY_PROXY_MARKER = join(lockDir, "tripped");
			try {
				const child = await spawnAgy(
					process.execPath,
					[
						join(import.meta.dir, "../fixtures/record-agy-launch.ts"),
						markerFile,
					],
					process.cwd(),
				);
				expect(await child.exited).toBe(0);
				expect(existsSync(markerFile)).toBe(true);
				expect(existsSync(process.env.AGY_ACP_FLAKY_PROXY_MARKER)).toBe(true);
			} finally {
				delete process.env.AGY_ACP_FLAKY_PROXY_MARKER;
			}
		});

		it("rejects when the proxy never signals ready", async () => {
			process.env.AGY_ACP_PROXY_ENTRYPOINT = join(
				import.meta.dir,
				"../fixtures/stalled-proxy.ts",
			);
			process.env.AGY_ACP_HANDSHAKE_TIMEOUT_MS = "200";
			try {
				await expect(
					spawnAgy(process.execPath, ["prompt"], process.cwd()),
				).rejects.toThrow("timed out waiting for agy process proxy ready");
			} finally {
				delete process.env.AGY_ACP_HANDSHAKE_TIMEOUT_MS;
			}
		});

		it("continues after a separate lock-holder process dies", async () => {
			const holder = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "../fixtures/hold-agy-process-lock.ts"),
					process.env.AGY_ACP_LOCK_FILE as string,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			try {
				const reader = holder.stdout.getReader();
				const ready = await reader.read();
				reader.releaseLock();
				expect(new TextDecoder().decode(ready.value)).toContain("ready");

				const mockSpawn = spyOn(Bun, "spawn").mockReturnValue({
					exited: Promise.resolve(0),
				} as any);
				const pending = runAgyProcessProxy(
					encodeProxyRequest({
						binary: "my-agy",
						args: ["after-holder"],
						cwd: "/some/cwd",
					}),
				);

				const stateWhileHeld = await Promise.race([
					pending.then(() => "spawned"),
					Bun.sleep(10).then(() => "waiting"),
				]);
				expect(stateWhileHeld).toBe("waiting");

				holder.kill();
				await holder.exited;
				await pending;
				expect(mockSpawn).toHaveBeenCalledTimes(1);
			} finally {
				holder.kill();
				await holder.exited;
			}
		});

		it("cancels a queued proxy before it launches agy", async () => {
			const holder = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "../fixtures/hold-agy-process-lock.ts"),
					process.env.AGY_ACP_LOCK_FILE as string,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const markerFile = join(lockDir, "agy-launched");
			try {
				const reader = holder.stdout.getReader();
				await reader.read();
				reader.releaseLock();

				const controller = new AbortController();
				const proxy = spawnAgy(
					process.execPath,
					[
						join(import.meta.dir, "../fixtures/record-agy-launch.ts"),
						markerFile,
					],
					process.cwd(),
					controller.signal,
				);
				controller.abort();
				await expect(proxy).rejects.toBeInstanceOf(Error);

				expect(existsSync(markerFile)).toBe(false);
			} finally {
				holder.kill();
				await holder.exited;
			}
		});

		it("cancels a queued proxy when its bridge exits", async () => {
			const holder = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "../fixtures/hold-agy-process-lock.ts"),
					process.env.AGY_ACP_LOCK_FILE as string,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const markerFile = join(lockDir, "orphan-launched");
			let launcher: ReturnType<typeof Bun.spawn> | undefined;
			try {
				const holderReader = holder.stdout.getReader();
				await holderReader.read();
				holderReader.releaseLock();

				launcher = Bun.spawn(
					[
						process.execPath,
						join(import.meta.dir, "../fixtures/launch-queued-proxy.ts"),
						process.env.AGY_ACP_LOCK_FILE as string,
						markerFile,
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const launcherReader = (
					launcher.stdout as ReadableStream<Uint8Array>
				).getReader();
				const queued = await launcherReader.read();
				launcherReader.releaseLock();
				expect(new TextDecoder().decode(queued.value)).toContain("queued");
				launcher.kill();
				await launcher.exited;

				await Bun.sleep(100);
				holder.kill();
				await holder.exited;
				await Bun.sleep(300);
				expect(existsSync(markerFile)).toBe(false);
			} finally {
				launcher?.kill();
				if (launcher) await launcher.exited;
				holder.kill();
				await holder.exited;
			}
		});

		it("cancels a running agy child through the proxy", async () => {
			const startedFile = join(lockDir, "started");
			const finishedFile = join(lockDir, "finished");
			const proxy = await spawnAgy(
				process.execPath,
				[
					join(import.meta.dir, "../fixtures/slow-agy.ts"),
					startedFile,
					finishedFile,
					"500",
				],
				process.cwd(),
			);
			for (
				let attempt = 0;
				attempt < 100 && !existsSync(startedFile);
				attempt++
			) {
				await Bun.sleep(10);
			}
			expect(existsSync(startedFile)).toBe(true);

			proxy.kill();
			proxy.kill();
			expect(await proxy.exited).not.toBe(0);
			await Bun.sleep(600);
			expect(existsSync(finishedFile)).toBe(false);
		});

		it("keeps serialization after the bridge parent exits", async () => {
			const firstStarted = join(lockDir, "first-started");
			const firstFinished = join(lockDir, "first-finished");
			const secondStarted = join(lockDir, "second-started");
			const launcher = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "../fixtures/launch-proxy-and-exit.ts"),
					process.env.AGY_ACP_LOCK_FILE as string,
					firstStarted,
					firstFinished,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const proxyPid = Number(
				(await new Response(launcher.stdout).text()).trim(),
			);
			await launcher.exited;
			expect(proxyPid).toBeGreaterThan(0);

			try {
				for (
					let attempt = 0;
					attempt < 100 && !existsSync(firstStarted);
					attempt++
				) {
					await Bun.sleep(10);
				}
				expect(existsSync(firstStarted)).toBe(true);

				const second = await spawnAgy(
					process.execPath,
					[
						join(import.meta.dir, "../fixtures/record-agy-launch.ts"),
						secondStarted,
					],
					process.cwd(),
				);
				await second.exited;

				expect(existsSync(firstFinished)).toBe(true);
				expect(existsSync(secondStarted)).toBe(true);
			} finally {
				try {
					process.kill(proxyPid, "SIGKILL");
				} catch {
					// The proxy normally exits before cleanup.
				}
			}
		});

		it("releases the lock when spawning agy throws", async () => {
			const mockSpawn = spyOn(Bun, "spawn");
			mockSpawn.mockImplementationOnce(() => {
				throw new Error("spawn failed");
			});
			mockSpawn.mockReturnValueOnce({
				exited: Promise.resolve(0),
			} as any);

			await expect(
				runAgyProcessProxy(
					encodeProxyRequest({
						binary: "my-agy",
						args: ["first"],
						cwd: "/some/cwd",
					}),
				),
			).rejects.toThrow("spawn failed");
			await runAgyProcessProxy(
				encodeProxyRequest({
					binary: "my-agy",
					args: ["second"],
					cwd: "/some/cwd",
				}),
			);

			expect(mockSpawn).toHaveBeenCalledTimes(2);
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

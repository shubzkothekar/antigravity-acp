// @ts-nocheck
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	AGY_VERSION,
	ensureAgy,
	extractTarGz,
	extractZip,
	findBinary,
	GITHUB_REPO,
	RELEASES,
	releaseUrl,
	sha256hex,
} from "../../src/agy/installer";

describe("agy/installer.ts", () => {
	let logMock: ReturnType<typeof mock>;
	let warnMock: ReturnType<typeof mock>;
	let originalEnv: NodeJS.ProcessEnv;
	let originalPlatform: string;
	let originalArch: string;

	beforeEach(() => {
		logMock = mock();
		warnMock = mock();
		originalEnv = { ...process.env };
		originalPlatform = process.platform;
		originalArch = process.arch;
		delete process.env.AGY_SKIP_DOWNLOAD;
		delete process.env.AGY_BIN;
	});

	afterEach(() => {
		mock.restore();
		process.env = originalEnv;
		Object.defineProperty(process, "platform", { value: originalPlatform });
		Object.defineProperty(process, "arch", { value: originalArch });
	});

	describe("releaseUrl()", () => {
		it("should format the URL correctly", () => {
			expect(releaseUrl("my-asset.zip")).toBe(
				`https://github.com/${GITHUB_REPO}/releases/download/${AGY_VERSION}/my-asset.zip`,
			);
		});
	});

	describe("sha256hex()", () => {
		it("should compute correct sha256 hex", () => {
			const buf = Buffer.from("hello world");
			expect(sha256hex(buf)).toBe(
				"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
			);
		});
	});

	describe("extractTarGz()", () => {
		it("should throw on non-zero exit code", async () => {
			spyOn(Bun, "spawn").mockReturnValue({
				stderr: "some tar error",
				exited: Promise.resolve(1),
			} as any);

			await expect(extractTarGz("dummy.tar.gz", "dest")).rejects.toThrow(
				"tar exited 1: some tar error",
			);
		});

		it("should succeed on zero exit code", async () => {
			spyOn(Bun, "spawn").mockReturnValue({
				exited: Promise.resolve(0),
			} as any);

			await expect(
				extractTarGz("dummy.tar.gz", "dest"),
			).resolves.toBeUndefined();
		});
	});

	describe("extractZip()", () => {
		it("should throw on non-zero exit code", async () => {
			spyOn(Bun, "spawn").mockReturnValue({
				stderr: "some zip error",
				exited: Promise.resolve(1),
			} as any);

			await expect(extractZip("dummy.zip", "dest")).rejects.toThrow(
				"Expand-Archive exited 1: some zip error",
			);
		});

		it("should succeed on zero exit code", async () => {
			spyOn(Bun, "spawn").mockReturnValue({
				exited: Promise.resolve(0),
			} as any);

			await expect(extractZip("dummy.zip", "dest")).resolves.toBeUndefined();
		});
	});

	describe("findBinary()", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "find-binary-test-"));
		});

		afterEach(() => {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it("should find binary in root dir", () => {
			fs.writeFileSync(path.join(tmpDir, "my-bin"), "exe");
			expect(findBinary(tmpDir, "my-bin")).toBe(path.join(tmpDir, "my-bin"));
		});

		it("should find binary in nested dir", () => {
			const nested = path.join(tmpDir, "nested");
			fs.mkdirSync(nested);
			fs.writeFileSync(path.join(nested, "my-bin"), "exe");
			expect(findBinary(tmpDir, "my-bin")).toBe(path.join(nested, "my-bin"));
		});

		it("should gracefully return null if depth is exceeded", () => {
			const deep = path.join(tmpDir, "a", "b", "c");
			fs.mkdirSync(deep, { recursive: true });
			fs.writeFileSync(path.join(deep, "my-bin"), "exe");
			expect(findBinary(tmpDir, "my-bin", 1)).toBeNull();
			expect(findBinary(tmpDir, "my-bin", 2)).toBeNull();
			expect(findBinary(tmpDir, "my-bin", 3)).toBe(path.join(deep, "my-bin"));
		});

		it("should return null if not found", () => {
			expect(findBinary(tmpDir, "does-not-exist")).toBeNull();
		});

		it("should return null if directory does not exist", () => {
			expect(findBinary(path.join(tmpDir, "invalid"), "bin")).toBeNull();
		});
	});

	describe("ensureAgy() exit routes", () => {
		const destDir = "/mock/dest";

		it("should skip if AGY_SKIP_DOWNLOAD=1", async () => {
			process.env.AGY_SKIP_DOWNLOAD = "1";
			await ensureAgy({ destDir, log: logMock, warn: warnMock });
			expect(logMock).toHaveBeenCalledWith(
				"[agy-acp] skipping agy download (AGY_SKIP_DOWNLOAD=1)",
			);
		});

		it("should skip if AGY_BIN is set", async () => {
			process.env.AGY_BIN = "/path/to/agy";
			await ensureAgy({ destDir, log: logMock, warn: warnMock });
			expect(logMock).toHaveBeenCalledWith(
				"[agy-acp] using $AGY_BIN=/path/to/agy, skipping download",
			);
		});

		it("should warn on unsupported platform", async () => {
			Object.defineProperty(process, "platform", { value: "unknown_platform" });
			await ensureAgy({ destDir, log: logMock, warn: warnMock });
			expect(warnMock).toHaveBeenCalledWith(
				expect.stringContaining("WARN: unsupported platform unknown_platform-"),
			);
		});

		it("should skip if binary already present and executable", async () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			Object.defineProperty(process, "arch", { value: "x64" });

			spyOn(fs, "accessSync").mockImplementation(() => undefined); // Success

			await ensureAgy({ destDir, log: logMock, warn: warnMock });
			expect(logMock).toHaveBeenCalledWith(
				expect.stringContaining("agy already present"),
			);
		});

		it("should handle fetch network error", async () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			Object.defineProperty(process, "arch", { value: "x64" });

			spyOn(fs, "accessSync").mockImplementation(() => {
				throw new Error("not found");
			});
			global.fetch = mock().mockRejectedValue(new Error("Network Failure"));

			await ensureAgy({ destDir, log: logMock, warn: warnMock });
			expect(warnMock).toHaveBeenCalledWith(
				expect.stringContaining(
					"WARN: network error downloading agy: Network Failure",
				),
			);
		});

		it("should handle HTTP non-ok status", async () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			Object.defineProperty(process, "arch", { value: "x64" });

			spyOn(fs, "accessSync").mockImplementation(() => {
				throw new Error("not found");
			});
			global.fetch = mock().mockResolvedValue({
				ok: false,
				status: 404,
				statusText: "Not Found",
			});

			await ensureAgy({ destDir, log: logMock, warn: warnMock });
			expect(warnMock).toHaveBeenCalledWith(
				expect.stringContaining("WARN: HTTP 404 Not Found downloading agy"),
			);
		});

		it("should reject on mismatching checksums", async () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			Object.defineProperty(process, "arch", { value: "x64" });

			spyOn(fs, "accessSync").mockImplementation(() => {
				throw new Error("not found");
			});

			// Return some fake bytes that definitely won't match
			global.fetch = mock().mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
			});

			await ensureAgy({ destDir, log: logMock, warn: warnMock });
			expect(warnMock).toHaveBeenCalledWith(
				expect.stringContaining("WARN: SHA256 mismatch"),
			);
		});
	});

	describe("ensureAgy() successful extraction", () => {
		const destDir = "/mock/dest";

		it("should successfully fetch and extract tar.gz for linux-x64", async () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			Object.defineProperty(process, "arch", { value: "x64" });

			const release = RELEASES["linux-x64"];
			// Create a fake archive that matches the expected SHA256
			// Since we can't easily fake the exact SHA256 bytes for a huge hash,
			// let's temporarily mutate the RELEASES dictionary for testing
			const fakeBytes = Buffer.from("fake-archive-data");
			const fakeSha256 = sha256hex(fakeBytes);

			const originalSha256 = release.sha256;
			release.sha256 = fakeSha256;

			spyOn(fs, "accessSync").mockImplementation(() => {
				throw new Error("not found");
			});

			global.fetch = mock().mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(fakeBytes.buffer),
			});

			// Mock filesystem operations during extraction
			const _mkdtempSyncSpy = spyOn(fs, "mkdtempSync").mockReturnValue(
				"/mock/tmp/agy-acp-123",
			);
			const _writeFileSyncSpy = spyOn(fs, "writeFileSync").mockImplementation(
				() => {},
			);
			const _mkdirSyncSpy = spyOn(fs, "mkdirSync").mockImplementation(
				() => undefined,
			);
			const _rmSyncSpy = spyOn(fs, "rmSync").mockImplementation(() => {});
			const copyFileSyncSpy = spyOn(fs, "copyFileSync").mockImplementation(
				() => {},
			);
			const chmodSyncSpy = spyOn(fs, "chmodSync").mockImplementation(() => {});

			// Mock finding binary
			const _readdirSyncSpy = spyOn(fs, "readdirSync").mockReturnValue([
				{ name: "agy", isFile: () => true, isDirectory: () => false } as any,
			]);

			// Mock tar spawn
			const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
				exited: Promise.resolve(0),
			} as any);

			await ensureAgy({ destDir, log: logMock, warn: warnMock });

			// Verify execution
			expect(spawnSpy).toHaveBeenCalled();
			expect(copyFileSyncSpy).toHaveBeenCalledWith(
				path.join("/mock/tmp/agy-acp-123/extracted", "agy"),
				path.join(destDir, "agy"),
			);
			expect(chmodSyncSpy).toHaveBeenCalled();
			expect(logMock).toHaveBeenCalledWith(
				expect.stringContaining("installed →"),
			);

			// Restore
			release.sha256 = originalSha256;
		});

		it("should successfully fetch and extract zip for win32-x64", async () => {
			Object.defineProperty(process, "platform", { value: "win32" });
			Object.defineProperty(process, "arch", { value: "x64" });

			const release = RELEASES["win32-x64"];
			const fakeBytes = Buffer.from("fake-zip-data");
			const fakeSha256 = sha256hex(fakeBytes);

			const originalSha256 = release.sha256;
			release.sha256 = fakeSha256;

			spyOn(fs, "accessSync").mockImplementation(() => {
				throw new Error("not found");
			});

			global.fetch = mock().mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(fakeBytes.buffer),
			});

			spyOn(fs, "mkdtempSync").mockReturnValue("/mock/tmp/agy-acp-123");
			spyOn(fs, "writeFileSync").mockImplementation(() => {});
			spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
			spyOn(fs, "rmSync").mockImplementation(() => {});
			spyOn(fs, "copyFileSync").mockImplementation(() => {});
			spyOn(fs, "chmodSync").mockImplementation(() => {}); // should not be called for win32 but let's mock just in case

			spyOn(fs, "readdirSync").mockReturnValue([
				{
					name: "agy.exe",
					isFile: () => true,
					isDirectory: () => false,
				} as any,
			]);

			const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
				exited: Promise.resolve(0),
			} as any);

			await ensureAgy({ destDir, log: logMock, warn: warnMock });

			expect(spawnSpy).toHaveBeenCalledWith(
				expect.arrayContaining(["powershell", "-NoProfile"]),
				expect.any(Object),
			);

			expect(logMock).toHaveBeenCalledWith(
				expect.stringContaining("installed →"),
			);

			release.sha256 = originalSha256;
		});

		it("should warn if binary not found inside extracted archive", async () => {
			Object.defineProperty(process, "platform", { value: "linux" });
			Object.defineProperty(process, "arch", { value: "x64" });

			const release = RELEASES["linux-x64"];
			const fakeBytes = Buffer.from("fake-archive-data");
			release.sha256 = sha256hex(fakeBytes);

			spyOn(fs, "accessSync").mockImplementation(() => {
				throw new Error("not found");
			});
			global.fetch = mock().mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(fakeBytes.buffer),
			});

			spyOn(fs, "mkdtempSync").mockReturnValue("/mock/tmp/agy-acp-123");
			spyOn(fs, "writeFileSync").mockImplementation(() => {});
			spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
			spyOn(fs, "rmSync").mockImplementation(() => {});

			// Mock finding NO binary
			spyOn(fs, "readdirSync").mockReturnValue([
				{
					name: "readme.txt",
					isFile: () => true,
					isDirectory: () => false,
				} as any,
			]);

			spyOn(Bun, "spawn").mockReturnValue({
				exited: Promise.resolve(0),
			} as any);

			await ensureAgy({ destDir, log: logMock, warn: warnMock });

			expect(warnMock).toHaveBeenCalledWith(
				expect.stringContaining("WARN: could not locate agy inside"),
			);
		});
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";

describe("ACP Server E2E", () => {
	let proc: ReturnType<typeof Bun.spawn>;
	let connection: any;
	let stateDir: string;

	beforeAll(async () => {
		stateDir = mkdtempSync(join(tmpdir(), "agy-acp-e2e-"));
		proc = Bun.spawn(["bun", "run", "index.ts"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
			env: {
				...process.env,
				AGY_SKIP_DOWNLOAD: "1", // to speed it up and avoid downloading if it tries to
				// Keep background model discovery off the real `agy` binary and off
				// the shared default lock, so it can't outlive or slow down the suite.
				AGY_BIN: join(stateDir, "no-such-agy"),
				AGY_ACP_LOCK_FILE: join(stateDir, "agy-process-lock.sqlite"),
			},
		});

		// We need to create a WritableStream to write to proc.stdin
		const stdinWritable = new WritableStream<Uint8Array>({
			write(chunk) {
				(proc.stdin as any).write(chunk);
				(proc.stdin as any).flush();
			},
			close() {
				(proc.stdin as any).end();
			},
		});

		const stream = ndJsonStream(stdinWritable, proc.stdout as any);
		connection = client().connect(stream);
	});

	afterAll(async () => {
		if (connection) {
			await connection.close();
		}
		if (proc) {
			proc.kill();
			await proc.exited;
		}
		if (stateDir) {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	test("should initialize successfully", async () => {
		const res = await connection.agent.request(methods.agent.initialize, {
			protocolVersion: 1, // or sdk.PROTOCOL_VERSION but we can hardcode 1
			clientInfo: { name: "test-client", version: "1.0.0" },
		});
		expect(res).toBeDefined();
		expect((res as any).agentInfo.version).toBeDefined();
	});

	test("should list resources", async () => {
		const res = await connection.connection.sendRequest("resources/list", {});
		expect(res).toBeDefined();
	});

	test("should list prompts", async () => {
		const res = await connection.connection.sendRequest("prompts/list", {});
		expect(res).toBeDefined();
	});

	test("should list tools", async () => {
		const res = await connection.connection.sendRequest("tools/list", {});
		expect(res).toBeDefined();
	});

	test("should create and list sessions", async () => {
		const newRes = (await connection.agent.request(methods.agent.session.new, {
			cwd: process.cwd(),
			mcpServers: [],
		})) as any;
		expect(newRes).toBeDefined();
		expect(newRes.sessionId).toBeDefined();

		// Persist the session by setting a config option (e.g. mode)
		await connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId: newRes.sessionId,
			configId: "mode",
			value: "plan",
		});

		const listRes = (await connection.agent.request(
			methods.agent.session.list,
			{},
		)) as any;
		expect(listRes).toBeDefined();
		expect(listRes.sessions).toBeDefined();
		expect(Array.isArray(listRes.sessions)).toBe(true);

		const sessionExists = listRes.sessions.find(
			(s: any) => s.sessionId === newRes.sessionId,
		);
		expect(sessionExists).toBeDefined();

		// Cleanup: delete the session
		await connection.agent.request(methods.agent.session.delete, {
			sessionId: newRes.sessionId,
		});
		const postDeleteRes = (await connection.agent.request(
			methods.agent.session.list,
			{},
		)) as any;
		expect(
			postDeleteRes.sessions.find((s: any) => s.sessionId === newRes.sessionId),
		).toBeUndefined();
	});
});

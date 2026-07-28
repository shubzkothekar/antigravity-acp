// @ts-nocheck
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adapter } from "../../src/acp/adapter";
import { AgyAcpAgent } from "../../src/acp/agent";
import { SessionManager } from "../../src/acp/sessions";

const AUTH_METHOD_ID = "agy-agent";
const _PLAN_MODE_ID = "plan";

describe("AgyAcpAgent", () => {
	let agent: AgyAcpAgent;
	let clientMock: any;
	let lockDir: string;

	beforeEach(() => {
		lockDir = mkdtempSync(join(tmpdir(), "agy-acp-agent-lock-"));
		process.env.AGY_ACP_LOCK_FILE = join(lockDir, "agy.lock");
		clientMock = { update: mock(async () => {}) };

		// Mock SessionManager
		spyOn(SessionManager.prototype, "create").mockReturnValue({
			sessionId: "s1",
			session: { cwd: process.cwd() },
		} as any);
		spyOn(SessionManager.prototype, "ensure").mockResolvedValue({
			cwd: process.cwd(),
		} as any);
		spyOn(SessionManager.prototype, "peek").mockReturnValue({
			cwd: process.cwd(),
			conversationId: "c1",
		} as any);
		spyOn(SessionManager.prototype, "list").mockResolvedValue([
			{ sessionId: "s1", session: { cwd: process.cwd() } },
		] as any);
		spyOn(SessionManager.prototype, "delete").mockResolvedValue(true);
		spyOn(SessionManager.prototype, "evict").mockImplementation(() => {});
		spyOn(SessionManager.prototype, "adopt").mockImplementation(() => {});
		spyOn(SessionManager.prototype, "persist").mockResolvedValue();

		// Mock Adapter
		spyOn(Adapter.prototype, "cancel").mockImplementation(() => {});
		spyOn(Adapter.prototype, "runPrompt").mockResolvedValue({
			stopReason: "end_turn",
			error: undefined,
			conversationId: "c1",
			lastStepIdx: 1,
			hadUpdates: true,
		});

		agent = new AgyAcpAgent({
			workingDir: process.cwd(),
			skipNarration: false,
		} as any);
	});

	afterEach(() => {
		mock.restore();
		delete process.env.AGY_ACP_LOCK_FILE;
		rmSync(lockDir, { recursive: true, force: true });
	});

	test("initialize returns capabilities", async () => {
		const result = await agent.initialize();
		expect(result.agentCapabilities).toBeDefined();
	});

	test("authenticate throws for invalid method", () => {
		expect(() => agent.authenticate({ methodId: "invalid" })).toThrow();
	});

	test("authenticate succeeds for valid method", async () => {
		const result = await agent.authenticate({ methodId: AUTH_METHOD_ID });
		expect(result).toEqual({});
	});

	test("newSession creates a session", async () => {
		const res = await agent.newSession({ cwd: process.cwd() }, clientMock);
		expect(res.sessionId).toBe("s1");
	});

	test("loadSession throws if sessionId is missing", async () => {
		expect(agent.loadSession({} as any, clientMock)).rejects.toThrow();
	});

	test("resumeSession dirties on diff", async () => {
		const res = await agent.resumeSession(
			{ sessionId: "s1", cwd: "/tmp" },
			clientMock,
		);
		expect(res).toBeDefined();
	});

	test("listSessions returns wrapped sessions", async () => {
		const res = await agent.listSessions({});
		expect(res.sessions.length).toBe(1);
	});

	test("deleteSession calls delete", async () => {
		const res = await agent.deleteSession({ sessionId: "s1" });
		expect(res).toEqual({});
	});

	test("setConfigOption sets option", async () => {
		const res = await agent.setConfigOption({
			sessionId: "s1",
			configId: "mode",
			value: "plan",
		});
		expect(res).toBeDefined();
	});

	test("prompt handles mode injection", async () => {
		const res = await agent.prompt(
			{ sessionId: "s1", prompt: [{ type: "text", text: "hello" }] } as any,
			clientMock,
		);
		expect(res.stopReason).toBe("end_turn");
	});

	test("first prompt waits for startup model discovery", async () => {
		let finishDiscovery: (exitCode: number) => void = () => {};
		const discoveryExited = new Promise<number>((resolve) => {
			finishDiscovery = resolve;
		});
		spyOn(Bun, "spawn").mockReturnValue({
			stdout: "gemini-3.6-flash-high\n",
			exited: discoveryExited,
		} as any);

		const testAgent = new AgyAcpAgent({
			binary: "agy",
			workingDir: process.cwd(),
			conversationsDir: "/tmp",
			skipNarration: false,
			version: "test",
		});
		const prompt = testAgent.prompt(
			{ sessionId: "s1", prompt: [{ type: "text", text: "hello" }] } as any,
			clientMock,
		);

		const stateBeforeDiscovery = await Promise.race([
			prompt.then(() => "completed"),
			Bun.sleep(10).then(() => "waiting"),
		]);
		expect(stateBeforeDiscovery).toBe("waiting");

		finishDiscovery(0);
		await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
	});

	test("cancellation during model discovery does not start a prompt", async () => {
		let finishDiscovery: (exitCode: number) => void = () => {};
		const discoveryExited = new Promise<number>((resolve) => {
			finishDiscovery = resolve;
		});
		spyOn(Bun, "spawn").mockReturnValue({
			stdout: "gemini-3.6-flash-high\n",
			exited: discoveryExited,
		} as any);
		const runPromptSpy = spyOn(Adapter.prototype, "runPrompt");
		const testAgent = new AgyAcpAgent({
			binary: "agy",
			workingDir: process.cwd(),
			conversationsDir: "/tmp",
			skipNarration: false,
			version: "test",
		});

		const prompt = testAgent.prompt(
			{ sessionId: "s1", prompt: [{ type: "text", text: "hello" }] } as any,
			clientMock,
		);
		testAgent.cancel({ sessionId: "s1" });

		const stateAfterCancel = await Promise.race([
			prompt.then((result) => result.stopReason),
			Bun.sleep(10).then(() => "waiting"),
		]);
		expect(stateAfterCancel).toBe("cancelled");
		expect(runPromptSpy).not.toHaveBeenCalled();

		finishDiscovery(0);
		await Promise.resolve();
	});

	test("prompt formats ACP blocks into XML strings", async () => {
		const runPromptSpy = spyOn(
			Adapter.prototype,
			"runPrompt",
		).mockResolvedValue({
			stopReason: "end_turn",
			error: undefined,
			conversationId: "c1",
			lastStepIdx: 1,
			hadUpdates: true,
		});

		await agent.prompt(
			{
				sessionId: "s1",
				prompt: [
					{ type: "text", text: "Some text" },
					{
						type: "resource_link",
						uri: "https://example.com",
						title: "My Link",
					},
					{ type: "resource", resource: { uri: "file.txt", text: "Content" } },
				],
			} as any,
			clientMock,
		);

		const passedPrompt = runPromptSpy.mock.calls[0][2];
		expect(passedPrompt).toContain("<user_text>\nSome text\n</user_text>");
		expect(passedPrompt).toContain(
			`<resource_link uri="https://example.com" title="My Link"/>`,
		);
		expect(passedPrompt).toContain(
			`<embedded_resource uri="file.txt">\nContent\n</embedded_resource>`,
		);
	});
});

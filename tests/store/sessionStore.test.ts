import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionStore } from "../../src/store/sessionStore";
import type { StoredSession } from "../../src/types/session";

describe("SessionStore", () => {
	const tempDir = path.join(process.cwd(), "tmp-test-store");
	const tempFile = path.join(tempDir, "sessions.json");
	let store: SessionStore;

	beforeAll(() => {
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true });
		}
	});

	afterAll(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		if (fs.existsSync(tempFile)) {
			fs.unlinkSync(tempFile);
		}
		store = new SessionStore(tempFile, tempDir);
	});

	test("should return empty list initially", async () => {
		const sessions = await store.list();
		expect(sessions).toEqual([]);
	});

	test("should persist and restore a session", async () => {
		const sessionId = "test-session-1";
		const sessionData: StoredSession = {
			conversationId: "conv-1",
			lastStepIdx: 5,
			modelId: "model-x",
			permissionMode: "plan",
			effort: "high",
			// Derived from mode on load; plan => no sandbox/skip.
			sandbox: false,
			skipPermissions: false,
			cwd: "/path/to/cwd",
			additionalDirs: ["/path/to/dir"],
			title: "Test Title",
			updatedAt: "2026-06-29T00:00:00Z",
		};

		await store.persist(sessionId, sessionData);

		const restored = await store.restore(sessionId);
		expect(restored).toEqual(sessionData);

		const all = await store.list();
		expect(all).toHaveLength(1);
		expect(all[0]!.sessionId).toBe(sessionId);
		expect(all[0]!.session).toEqual(sessionData);
	});

	test("should return null when restoring non-existent session", async () => {
		const restored = await store.restore("non-existent");
		expect(restored).toBeNull();
	});

	test("should delete a session", async () => {
		const sessionId = "test-session-2";
		const sessionData: StoredSession = {
			conversationId: null,
			lastStepIdx: -1,
			modelId: null,
			permissionMode: null,
			effort: "medium",
			sandbox: false,
			skipPermissions: false,
			cwd: "",
			additionalDirs: [],
			title: null,
			updatedAt: new Date().toISOString(),
		};

		await store.persist(sessionId, sessionData);

		const deleted = await store.delete(sessionId);
		expect(deleted).toBe(true);

		const restored = await store.restore(sessionId);
		expect(restored).toBeNull();

		const deletedAgain = await store.delete(sessionId);
		expect(deletedAgain).toBe(false);
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Adapter } from "../../src/acp/adapter";
import type { AcpClient } from "../../src/acp/client";
import type { Session } from "../../src/types/session";
import { QUOTA_STEP_PAYLOAD_HEX } from "../fixtures/quota-step";

describe("Adapter quota handling", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("stops agy's silent 429 retry loop and surfaces the quota message", async () => {
		const dbPath = path.join(tempDir, "conv-1.db");
		// Stand-in for agy: record one 429 error step, then keep "retrying"
		// until interrupted, as the real CLI does.
		const fakeAgy = path.join(tempDir, "agy");
		fs.writeFileSync(
			fakeAgy,
			[
				"#!/usr/bin/env bun",
				'import { Database } from "bun:sqlite";',
				`const db = new Database(${JSON.stringify(dbPath)});`,
				'db.run("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)");',
				`db.query("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 17, 3, ?)").run(Buffer.from("${QUOTA_STEP_PAYLOAD_HEX}", "hex"));`,
				"db.close();",
				"setInterval(() => {}, 1000);",
				"",
			].join("\n"),
		);
		fs.chmodSync(fakeAgy, 0o755);

		const adapter = new Adapter({
			binary: fakeAgy,
			conversationsDir: tempDir,
			workingDir: tempDir,
			skipNarration: true,
		});
		const session: Session = {
			conversationId: null,
			lastStepIdx: -1,
			modelId: null,
			permissionMode: null,
			cwd: tempDir,
			additionalDirs: [],
			title: null,
			updatedAt: new Date().toISOString(),
		};
		const client = { update: async () => {} } as unknown as AcpClient;

		const started = Date.now();
		const outcome = await adapter.runPrompt("s1", session, "hi", client);

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(outcome.error).toContain(
			"Individual quota reached. Please upgrade your subscription to increase your limits.",
		);
		expect(outcome.error).toContain(
			"Error ID: 00000000-0000-4000-8000-000000000002-1",
		);
		expect(outcome.error).toContain(
			"Your plan's baseline quota will refresh on",
		);
	}, 10_000);
});

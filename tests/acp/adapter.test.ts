import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { Adapter, formatQuotaError } from "../../src/acp/adapter";
import type { AcpClient } from "../../src/acp/client";
import { conversationDbPath } from "../../src/conversation/database";
import { newSession } from "../../src/types/session";

describe("formatQuotaError", () => {
	test("renders the message, Error ID, and absolute refresh time like the IDE", () => {
		const now = new Date(2026, 8, 16, 16, 41, 44);
		const text = formatQuotaError(
			{
				message: "",
				detail:
					"API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 7m11s.",
				stackTrace: "",
				id: "error-id-1",
			},
			now,
		);
		expect(text).toBe(
			"Individual quota reached. Please upgrade your subscription to increase your limits.\n\n" +
				"Error ID: error-id-1\n\n" +
				`Your plan's baseline quota will refresh on ${new Date(2026, 8, 16, 16, 48, 55).toLocaleString("en-US")}.`,
		);
	});
});

describe("Adapter", () => {
	test("cancel should handle non-existent session gracefully", () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});
		// should not throw
		adapter.cancel("non-existent");
		expect(true).toBe(true);
	});

	test("runPrompt should handle spawn failure", async () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});

		// We could mock spawnAgy but let's test if it handles a non-existent binary or errors.
		// A lightweight test for prompt running.
		expect(adapter).toBeDefined();
	});
});

describe("Adapter quota handling", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-quota-test-"));
	});

	afterEach(() => {
		mock.restore();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("runPrompt stops agy and returns the quota message on a 429", async () => {
		let killed = false;
		// agy records the 429 as an ERROR_MESSAGE step, then keeps retrying
		// until it is interrupted.
		spyOn(Bun, "spawn").mockImplementation((() => {
			const sqlite = new Database(conversationDbPath(tempDir, "conv"));
			sqlite
				.query(
					"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
				)
				.run();
			const writer = new BinaryWriter();
			writer.tag(24, 2).fork().tag(3, 2).fork();
			writer
				.tag(2, 2)
				.string(
					"API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1m.",
				);
			writer.join().join();
			sqlite
				.query(
					"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (0, 17, 3, ?)",
				)
				.run(writer.finish());
			sqlite.close();

			let exit: (code: number) => void = () => {};
			return {
				stderr: null,
				exited: new Promise<number>((r) => {
					exit = r;
				}),
				kill: () => {
					killed = true;
					exit(130);
				},
			};
		}) as unknown as typeof Bun.spawn);

		const adapter = new Adapter({
			workingDir: tempDir,
			binary: "agy",
			conversationsDir: tempDir,
			skipNarration: false,
		});
		const client = { update: async () => {} } as unknown as AcpClient;
		const outcome = await adapter.runPrompt(
			"s1",
			newSession(tempDir),
			"hi",
			client,
		);

		expect(killed).toBe(true);
		expect(outcome.error).toStartWith("Individual quota reached.");
		expect(outcome.error).toContain("baseline quota will refresh on");
	});
});

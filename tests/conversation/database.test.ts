// @ts-nocheck
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import {
	ConversationDb,
	conversationDbPath,
	readRows,
	statConversation,
} from "../../src/conversation/database";
import { StepPayload } from "../../src/gen/steps";

describe("conversation/database", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-db-test-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("conversationDbPath returns correct path", () => {
		const dbPath = conversationDbPath(tempDir, "test-id");
		expect(dbPath).toBe(path.join(tempDir, "test-id.db"));
	});

	test("statConversation returns stat for existing db", () => {
		const dbPath = conversationDbPath(tempDir, "test-id");
		fs.writeFileSync(dbPath, "mock data");

		const stat = statConversation(tempDir, "test-id");
		expect(stat).not.toBeNull();
		expect(stat?.size).toBe(9);
		expect(stat?.mtimeMs).toBeGreaterThan(0);
	});

	test("statConversation returns null for missing db", () => {
		const stat = statConversation(tempDir, "missing-id");
		expect(stat).toBeNull();
	});

	test("ConversationDb.open returns null if db doesn't exist", () => {
		const db = ConversationDb.open(tempDir, "missing");
		expect(db).toBeNull();
	});

	test("ConversationDb.open returns null if unreadable or invalid db", () => {
		// Mock Database constructor error
		const dbPath = conversationDbPath(tempDir, "invalid");
		fs.writeFileSync(dbPath, "invalid-sqlite-file");
		// Database constructor will actually fail or query will fail if not valid sqlite
		// But in this case bun:sqlite might still open it, so let's see.
		// Actually, let's test missing steps table first.
		const db = ConversationDb.open(tempDir, "invalid");
		expect(db).toBeNull(); // Missing steps table
	});

	test("ConversationDb.open returns null and logs error if steps table is missing", () => {
		const dbPath = conversationDbPath(tempDir, "no-steps");
		const sqlite = new Database(dbPath);
		sqlite.query("CREATE TABLE other (id INTEGER)").run();
		sqlite.close();

		const errorMock = mock(() => {});
		const originalError = console.error;
		console.error = errorMock;

		const db = ConversationDb.open(tempDir, "no-steps");
		expect(db).toBeNull();
		expect(errorMock).toHaveBeenCalled();
		expect(errorMock.mock.calls[0][0]).toContain("steps table not found");

		console.error = originalError;
	});

	test("ConversationDb.open succeeds if steps table exists", () => {
		const dbPath = conversationDbPath(tempDir, "valid");
		const sqlite = new Database(dbPath);
		sqlite
			.query(
				"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
			)
			.run();
		sqlite.close();

		const db = ConversationDb.open(tempDir, "valid");
		expect(db).not.toBeNull();
		db?.close();
	});

	test("readAfter decodes rows correctly", () => {
		const dbPath = conversationDbPath(tempDir, "read");
		const sqlite = new Database(dbPath);
		sqlite
			.query(
				"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
			)
			.run();

		const emptyPayload = StepPayload.encode(StepPayload.create({})).finish();

		sqlite
			.query(
				"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
			)
			.run(1, 14, 0, emptyPayload);

		// Null status should become 0
		sqlite
			.query(
				"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
			)
			.run(2, 15, null, emptyPayload);

		sqlite.close();

		const db = ConversationDb.open(tempDir, "read");
		expect(db).not.toBeNull();

		const rows = db!.readAfter(0);
		expect(rows.length).toBe(2);

		expect(rows[0].idx).toBe(1);
		expect(rows[0].stepType).toBe(14);
		expect(rows[0].status).toBe(0);

		expect(rows[1].idx).toBe(2);
		expect(rows[1].stepType).toBe(15);
		expect(rows[1].status).toBe(0); // Coerced from null

		db!.close();
	});

	test("readRows one-shot read", () => {
		const dbPath = conversationDbPath(tempDir, "oneshot");
		const sqlite = new Database(dbPath);
		sqlite
			.query(
				"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
			)
			.run();

		const emptyPayload = StepPayload.encode(StepPayload.create({})).finish();
		sqlite
			.query(
				"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
			)
			.run(10, 23, 0, emptyPayload);
		sqlite.close();

		const rows = readRows(tempDir, "oneshot", 5);
		expect(rows).not.toBeNull();
		expect(rows!.length).toBe(1);
		expect(rows![0].idx).toBe(10);
	});

	test("readRows returns null for missing DB", () => {
		const rows = readRows(tempDir, "missing-oneshot", 5);
		expect(rows).toBeNull();
	});

	test("readAfter maps the usage block onto the row", () => {
		const dbPath = conversationDbPath(tempDir, "usage");
		const sqlite = new Database(dbPath);
		sqlite
			.query(
				"CREATE TABLE steps (idx INTEGER, step_type INTEGER, status INTEGER, step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)",
			)
			.run();

		// 1: step_type self-check, 5: { 9: { 2: input, 5: cache read, 9: reasoning, 10: visible } }
		const writer = new BinaryWriter();
		writer.tag(1, 0).uint32(15);
		writer.tag(5, 2).fork();
		writer.tag(9, 2).fork();
		writer.tag(2, 0).uint32(11751);
		writer.tag(5, 0).uint32(16609);
		writer.tag(9, 0).uint32(165);
		writer.tag(10, 0).uint32(60);
		writer.join();
		writer.join();
		sqlite
			.query(
				"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
			)
			.run(1, 15, 3, writer.finish());

		// A step without a usage block leaves the field null.
		const bare = StepPayload.encode(StepPayload.create({})).finish();
		sqlite
			.query(
				"INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)",
			)
			.run(2, 15, 3, bare);
		sqlite.close();

		const db = ConversationDb.open(tempDir, "usage");
		expect(db).not.toBeNull();

		const rows = db!.readAfter(-1);
		expect(rows.length).toBe(2);
		expect(rows[0].usage).toEqual({
			inputTokens: 11751,
			cacheReadTokens: 16609,
			reasoningTokens: 165,
			visibleOutputTokens: 60,
		});
		expect(rows[1].usage).toBeNull();

		db!.close();
	});

	test("Database constructor throwing error returns null", () => {
		// Mock new Database to throw
		// As an alternative, let's create a directory with the name of the DB to force a failure
		const dbPath = conversationDbPath(tempDir, "dir-as-file");
		fs.mkdirSync(dbPath);

		const db = ConversationDb.open(tempDir, "dir-as-file");
		expect(db).toBeNull();
	});
});

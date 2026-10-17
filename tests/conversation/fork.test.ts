import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { forkConversation } from "../../src/conversation/fork";

const SRC = "0c00cdb4-4086-4a32-9b01-a100fea4e6c9";
const TRAJ = "483b130a-cd7f-450a-b5f4-28be4cd90936";

/** Minimal agy-shaped conversation DB with ids embedded in protobuf-ish blobs. */
function makeConversation(dir: string): string {
	const file = path.join(dir, `${SRC}.db`);
	const db = new Database(file);
	db.run("PRAGMA journal_mode=WAL");
	db.run(
		"CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id))",
	);
	db.run(
		"CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, PRIMARY KEY (idx))",
	);
	db.run(
		"CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id))",
	);
	db.run("INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)", [TRAJ, SRC]);
	const blob = (s: string) =>
		Buffer.concat([Buffer.from([0x0a, s.length]), Buffer.from(s)]);
	db.run("INSERT INTO steps (idx, metadata, step_payload) VALUES (0, ?, ?)", [
		blob(SRC),
		Buffer.concat([blob(TRAJ), blob("hello")]),
	]);
	db.run("INSERT INTO steps (idx, metadata, step_payload) VALUES (3, ?, ?)", [
		blob(SRC),
		blob("world"),
	]);
	db.run("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)", [
		blob(SRC),
	]);
	db.close();
	// agy removes these when it exits; a read-only open would then fail.
	fs.rmSync(`${file}-wal`, { force: true });
	fs.rmSync(`${file}-shm`, { force: true });
	return file;
}

describe("conversation/fork", () => {
	let dir: string;
	let conversations: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fork-test-"));
		conversations = path.join(dir, "conversations");
		fs.mkdirSync(conversations);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("clones the DB under new ids and leaves the source untouched", () => {
		const srcFile = makeConversation(conversations);
		const before = fs.readFileSync(srcFile);

		const { conversationId, lastStepIdx } = forkConversation(
			conversations,
			SRC,
		);

		expect(conversationId).not.toBe(SRC);
		expect(lastStepIdx).toBe(3);
		expect(fs.readFileSync(srcFile).equals(before)).toBe(true);

		const db = new Database(path.join(conversations, `${conversationId}.db`), {
			readonly: true,
		});
		expect(
			(db.query("PRAGMA journal_mode").get() as { journal_mode: string })
				.journal_mode,
		).toBe("wal");
		const meta = db.query("SELECT * FROM trajectory_meta").get() as {
			trajectory_id: string;
			cascade_id: string;
		};
		expect(meta.cascade_id).toBe(conversationId);
		expect(meta.trajectory_id).not.toBe(TRAJ);

		const all = Buffer.concat(
			(
				db.query("SELECT metadata, step_payload FROM steps").all() as Array<{
					metadata: Uint8Array;
					step_payload: Uint8Array;
				}>
			).flatMap((r) => [Buffer.from(r.metadata), Buffer.from(r.step_payload)]),
		);
		expect(all.includes(SRC)).toBe(false);
		expect(all.includes(TRAJ)).toBe(false);
		expect(all.includes(conversationId)).toBe(true);
		expect(all.includes(meta.trajectory_id)).toBe(true);
		expect(all.includes("hello")).toBe(true);
		// Length prefixes stay valid because UUIDs keep their length.
		const first = db
			.query("SELECT metadata FROM steps WHERE idx = 0")
			.get() as {
			metadata: Uint8Array;
		};
		expect(first.metadata[1]).toBe(36);
		db.close();
	});

	test("copies the brain directory when present", () => {
		makeConversation(conversations);
		const brain = path.join(dir, "brain", SRC);
		fs.mkdirSync(brain, { recursive: true });
		fs.writeFileSync(path.join(brain, "plan.md"), "plan");

		const { conversationId } = forkConversation(conversations, SRC);

		expect(
			fs.readFileSync(
				path.join(dir, "brain", conversationId, "plan.md"),
				"utf-8",
			),
		).toBe("plan");
	});

	test("throws for a missing or malformed source id", () => {
		expect(() => forkConversation(conversations, SRC)).toThrow(/not found/);
		expect(() => forkConversation(conversations, "../etc/passwd")).toThrow(
			/not an agy conversation id/,
		);
	});
});

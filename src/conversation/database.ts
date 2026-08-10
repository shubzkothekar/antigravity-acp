// Read-only access to agy's per-conversation SQLite databases.
// Prefers bun:sqlite under Bun; falls back to better-sqlite3 on Node/tsx.
//
// A `ConversationDb` keeps one DB handle + prepared statement open so the
// streaming poll loop can read repeatedly without re-opening the file each
// tick. One-shot `readRows` is provided for replay, where a single read is all
// that's needed.

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { StepPayload } from "../gen/steps";
import type { StepRow } from "../types";
import {
	decodeErrorDetails,
	decodePermissions,
	decodeTaskDetails,
} from "./columns";

const require = createRequire(import.meta.url);

const SELECT_ROWS =
	"SELECT idx, step_type, status, step_payload, error_details, permissions, task_details " +
	"FROM steps WHERE idx > ? ORDER BY idx";

interface RawRow {
	idx: number;
	step_type: number;
	status: number;
	step_payload: unknown;
	error_details: unknown;
	permissions: unknown;
	task_details: unknown;
}

interface SqliteStatement {
	all: (...params: unknown[]) => unknown[];
	get: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
	prepare: (sql: string) => SqliteStatement;
	close: () => void;
}

type OpenDatabase = (dbPath: string) => SqliteDatabase;

function createOpenDatabase(): OpenDatabase {
	// Prefer bun:sqlite when Bun is present to avoid NAPI panics from better-sqlite3.
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		try {
			const { Database } = require("bun:sqlite") as {
				Database: new (
					path: string,
					opts?: { readonly?: boolean },
				) => {
					query: (sql: string) => SqliteStatement;
					close: () => void;
				};
			};
			return (dbPath: string) => {
				const db = new Database(dbPath, { readonly: true });
				return {
					prepare: (sql: string) => db.query(sql),
					close: () => db.close(),
				};
			};
		} catch {
			// Fall through.
		}
	}

	const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
	return (dbPath: string) => {
		const db = new BetterSqlite3(dbPath, {
			readonly: true,
			fileMustExist: true,
		});
		return {
			prepare: (sql: string) => db.prepare(sql) as SqliteStatement,
			close: () => db.close(),
		};
	};
}

const openDatabase = createOpenDatabase();

function toUint8(v: unknown): Uint8Array {
	if (v instanceof Uint8Array) return v;
	if (Buffer.isBuffer(v)) return new Uint8Array(v);
	return new Uint8Array(0);
}

/** Decode an optional blob column, returning null when absent/empty. */
function decodeColumn<T>(v: unknown, decode: (b: Uint8Array) => T): T | null {
	const bytes = toUint8(v);
	return bytes.length === 0 ? null : decode(bytes);
}

function rowToStep(r: RawRow): StepRow {
	return {
		idx: r.idx,
		stepType: r.step_type,
		status: r.status ?? 0,
		stepPayload: StepPayload.decode(toUint8(r.step_payload)),
		error: decodeColumn(r.error_details, decodeErrorDetails),
		permission: decodeColumn(r.permissions, decodePermissions),
		task: decodeColumn(r.task_details, decodeTaskDetails),
	};
}

export function conversationDbPath(dir: string, id: string): string {
	return path.join(dir, `${id}.db`);
}

/** A live identity for a conversation DB file, used to validate caches. */
export interface DbStat {
	mtimeMs: number;
	size: number;
}

/** Stat a conversation DB, or null if it doesn't exist. */
export function statConversation(dir: string, id: string): DbStat | null {
	try {
		const s = fs.statSync(conversationDbPath(dir, id));
		return { mtimeMs: s.mtimeMs, size: s.size };
	} catch {
		return null;
	}
}

/** An open, reusable read handle on one conversation's steps table. */
export class ConversationDb {
	private constructor(
		private readonly db: SqliteDatabase,
		private readonly stmt: SqliteStatement,
	) {}

	/** Open a conversation DB, or null if missing/unreadable or lacking a steps table. */
	static open(dir: string, id: string): ConversationDb | null {
		const dbPath = conversationDbPath(dir, id);
		if (!fs.existsSync(dbPath)) return null;

		try {
			const db = openDatabase(dbPath);
			const hasSteps = db
				.prepare(
					"SELECT COUNT(*) > 0 AS present FROM sqlite_master WHERE type='table' AND name='steps'",
				)
				.get() as { present: number | boolean } | undefined;
			if (!Boolean(hasSteps?.present)) {
				db.close();
				console.error(
					`[agy-acp] WARN: steps table not found in ${id}.db — schema changed?`,
				);
				return null;
			}
			return new ConversationDb(db, db.prepare(SELECT_ROWS));
		} catch {
			return null;
		}
	}

	/** Read decoded step rows with idx > afterStepIdx, in order. */
	readAfter(afterStepIdx: number): StepRow[] {
		const rows = this.stmt.all(afterStepIdx) as RawRow[];
		return rows.map(rowToStep);
	}

	close(): void {
		this.db.close();
	}
}

/** One-shot read of decoded step rows with idx > afterStepIdx. Returns null if
 *  the DB is missing/unreadable. */
export function readRows(
	dir: string,
	id: string,
	afterStepIdx: number,
): StepRow[] | null {
	const conn = ConversationDb.open(dir, id);
	if (!conn) return null;
	try {
		return conn.readAfter(afterStepIdx);
	} finally {
		conn.close();
	}
}

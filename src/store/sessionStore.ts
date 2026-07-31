// Persistent session bindings at ~/.agy-acp/sessions.json.
//
// Writes are serialized through an in-process promise chain (so concurrent
// persists can't clobber each other) and committed atomically via temp-file +
// rename. This replaces the reference's cross-process mkdir spinlock: a single
// ACP server owns its state file, and the atomic rename keeps it crash-safe.

import * as fs from "node:fs";
import {
	canonicalizeMode,
	DEFAULT_EFFORT,
	DEFAULT_MODE_ID,
	resolveModeFlags,
	SESSIONS_FILE,
	STATE_DIR,
} from "../constants";
import type { StoredSession } from "../types/session";
import { readFileText, writeFile } from "../utils/process";

interface DiskStore {
	sessions: Record<string, StoredSession>;
}

function asBool(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (value === "on" || value === "true" || value === 1 || value === "1")
		return true;
	if (value === "off" || value === "false" || value === 0 || value === "0")
		return false;
	return fallback;
}

/** Normalize a raw session record from disk, supporting both camelCase (current)
 *  and snake_case (legacy) field names written by previous implementations. */
function normalizeSession(raw: Record<string, unknown>): StoredSession {
	const conversationId =
		(raw.conversationId as string | null | undefined) ??
		(raw.conversation_id as string | null | undefined) ??
		null;
	const lastStepIdx =
		(raw.lastStepIdx as number | undefined) ??
		(raw.last_step_idx as number | undefined) ??
		-1;
	const modelId =
		(raw.modelId as string | null | undefined) ??
		(raw.model_id as string | null | undefined) ??
		null;
	const rawMode =
		(raw.permissionMode as string | null | undefined) ??
		(raw.permission_mode as string | null | undefined) ??
		(raw.mode as string | null | undefined) ??
		null;
	const effort =
		(typeof raw.effort === "string" && raw.effort.length > 0
			? raw.effort
			: null) ?? DEFAULT_EFFORT;
	const legacySandbox = asBool(raw.sandbox, false);
	const legacySkip = asBool(
		raw.skipPermissions ?? raw.skip_permissions,
		false,
	);
	// Fold legacy independent safety flags into a single Mode preset.
	const canonical = canonicalizeMode(rawMode, legacySandbox, legacySkip);
	const flags = resolveModeFlags(canonical);
	const permissionMode =
		canonical === DEFAULT_MODE_ID ? null : canonical;
	const additionalDirs = Array.isArray(raw.additionalDirs)
		? (raw.additionalDirs as string[]).filter((d) => typeof d === "string")
		: [];
	return {
		conversationId,
		lastStepIdx,
		modelId,
		permissionMode,
		effort,
		sandbox: flags.sandbox,
		skipPermissions: flags.skipPermissions,
		cwd: (raw.cwd as string | undefined) ?? "",
		additionalDirs,
		title: (raw.title as string | null | undefined) ?? null,
		updatedAt:
			(raw.updatedAt as string | undefined) ?? new Date().toISOString(),
	};
}

export class SessionStore {
	private writeChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly file: string = SESSIONS_FILE,
		private readonly dir: string = STATE_DIR,
	) {}

	/** Restore a persisted session, or null if not found. */
	async restore(sessionId: string): Promise<StoredSession | null> {
		const session = (await this.load()).sessions[sessionId];
		return session ?? null;
	}

	/** List all persisted sessions. */
	async list(): Promise<Array<{ sessionId: string; session: StoredSession }>> {
		const store = await this.load();
		return Object.entries(store.sessions).map(([sessionId, session]) => ({
			sessionId,
			session,
		}));
	}

	/** Delete a session from persistent storage. Returns true if it existed.
	 *  Serialized through writeChain to prevent races with concurrent persist/delete calls. */
	delete(sessionId: string): Promise<boolean> {
		let found = false;
		const task = this.writeChain
			.then(async () => {
				const store = await this.load();
				if (!(sessionId in store.sessions)) return;
				found = true;
				delete store.sessions[sessionId];
				fs.mkdirSync(this.dir, { recursive: true });
				const tmp = `${this.file}.tmp`;
				await writeFile(tmp, JSON.stringify(store, null, 2));
				fs.renameSync(tmp, this.file);
			})
			.catch((err) => {
				console.error(
					`[agy-acp] WARN: failed to delete session: ${(err as Error).message}`,
				);
			});
		this.writeChain = task;
		return task.then(() => found);
	}

	/** Persist a session binding. Resolves once written (writes are serialized). */
	persist(sessionId: string, session: StoredSession): Promise<void> {
		this.writeChain = this.writeChain
			.then(() => this.writeOne(sessionId, session))
			.catch((err) => {
				console.error(
					`[agy-acp] WARN: failed to persist session: ${(err as Error).message}`,
				);
			});
		return this.writeChain;
	}

	private async load(): Promise<DiskStore> {
		try {
			const parsed = JSON.parse(await readFileText(this.file)) as {
				sessions?: Record<string, Record<string, unknown>>;
			};
			const raw = parsed.sessions ?? {};
			const sessions: Record<string, StoredSession> = {};
			for (const [id, entry] of Object.entries(raw)) {
				sessions[id] = normalizeSession(entry);
			}
			return { sessions };
		} catch {
			return { sessions: {} };
		}
	}

	private async writeOne(
		sessionId: string,
		session: StoredSession,
	): Promise<void> {
		const store = await this.load();
		store.sessions[sessionId] = session;
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.file}.tmp`;
		await writeFile(tmp, JSON.stringify(store, null, 2));
		fs.renameSync(tmp, this.file);
	}
}

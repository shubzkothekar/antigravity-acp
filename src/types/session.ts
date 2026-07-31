import {
	canonicalizeMode,
	DEFAULT_EFFORT,
	DEFAULT_MODE_ID,
	resolveModeFlags,
} from "../constants";

/** In-memory session state for a live ACP session. */
export interface Session {
	/** agy conversation id this session is bound to, or null until first prompt. */
	conversationId: string | null;
	/** Highest step idx already streamed/replayed to the client. */
	lastStepIdx: number;
	/** Selected model id, or null for agy's default. */
	modelId: string | null;
	/**
	 * Agent mode preset (UI source of truth for edit policy + safety):
	 * `default` | `accept-edits` | `plan` | `sandbox` | `accept-tools` |
	 * `accept-edits-tools`. `null` means default.
	 */
	permissionMode: string | null;
	/** Reasoning effort: `low` | `medium` | `high`. */
	effort: string;
	/**
	 * Derived cache of `--sandbox` from the mode preset (kept for persistence
	 * compatibility; prefer `permissionMode` + `resolveModeFlags`).
	 */
	sandbox: boolean;
	/**
	 * Derived cache of `--dangerously-skip-permissions` from the mode preset.
	 */
	skipPermissions: boolean;
	/** Working directory for this session (from session/new cwd param). */
	cwd: string;
	/** Extra workspace roots beyond cwd (from additionalDirectories param). */
	additionalDirs: string[];
	/** Human-readable title, set from conversation title updates. */
	title: string | null;
	/** ISO 8601 timestamp of last activity. */
	updatedAt: string;
}

/** The persisted subset of a session, written to sessions.json. */
export type StoredSession = Session;

/** Apply a mode preset and sync derived sandbox/skipPermissions fields. */
export function applyModePreset(session: Session, mode: string | null): void {
	const canonical = canonicalizeMode(mode, false, false);
	session.permissionMode =
		canonical === DEFAULT_MODE_ID ? null : canonical;
	const flags = resolveModeFlags(canonical);
	session.sandbox = flags.sandbox;
	session.skipPermissions = flags.skipPermissions;
}

/** Create a fresh, unbound session. */
export function newSession(
	cwd: string,
	additionalDirs: string[] = [],
): Session {
	return {
		conversationId: null,
		lastStepIdx: -1,
		modelId: null,
		permissionMode: null,
		effort: DEFAULT_EFFORT,
		sandbox: false,
		skipPermissions: false,
		cwd,
		additionalDirs,
		title: null,
		updatedAt: new Date().toISOString(),
	};
}

import { DEFAULT_EFFORT } from "../constants";

/** In-memory session state for a live ACP session. */
export interface Session {
	/** agy conversation id this session is bound to, or null until first prompt. */
	conversationId: string | null;
	/** Highest step idx already streamed/replayed to the client. */
	lastStepIdx: number;
	/** Selected model id, or null for agy's default. */
	modelId: string | null;
	/**
	 * Agent mode: `default` | `accept-edits` | `plan` | `bypassPermissions`.
	 * `null` means default. `bypassPermissions` is a legacy alias for skip-permissions.
	 */
	permissionMode: string | null;
	/** Reasoning effort: `low` | `medium` | `high`. */
	effort: string;
	/** Whether to pass `--sandbox` to agy. */
	sandbox: boolean;
	/** Whether to pass `--dangerously-skip-permissions` to agy. */
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

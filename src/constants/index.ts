import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();

/** Where agy writes its per-conversation SQLite databases.
 *  Override via AGY_CONVERSATIONS_DIR if agy uses a different path on this OS. */
export const CONVERSATION_DIR =
	process.env.AGY_CONVERSATIONS_DIR ||
	path.join(HOME, ".gemini", "antigravity-cli", "conversations");

/** Directory holding this server's persistent state (session bindings). */
export const STATE_DIR = path.join(HOME, ".agy-acp");

/** Persistent session-binding store. */
export const SESSIONS_FILE = path.join(STATE_DIR, "sessions.json");

/** Persistent model cache store. */
export const MODELS_CACHE_FILE = path.join(STATE_DIR, "models.json");

/** Poll interval (ms) for streaming new steps during a live prompt turn. */
export const POLL_INTERVAL_MS = 200;

/** Max sessions held in memory before the oldest is evicted. */
export const MAX_SESSIONS = 64;

/** Max conversations cached for fast replay before LRU eviction. */
export const MAX_REPLAY_CACHE = 32;

export const MODEL_CONFIG_ID = "model";
export const MODE_CONFIG_ID = "mode";
export const EFFORT_CONFIG_ID = "effort";
/** @deprecated Safety is folded into Mode presets; kept for old clients. */
export const SANDBOX_CONFIG_ID = "sandbox";
/** @deprecated Safety is folded into Mode presets; kept for old clients. */
export const SKIP_PERMISSIONS_CONFIG_ID = "skip_permissions";

export const DEFAULT_MODE_ID = "default";
export const ACCEPT_EDITS_MODE_ID = "accept-edits";
export const PLAN_MODE_ID = "plan";
/** Default edit policy + OS sandbox (`agy --sandbox`). */
export const SANDBOX_MODE_ID = "sandbox";
/**
 * Auto-approve tool permission prompts only
 * (`agy --dangerously-skip-permissions`).
 */
export const ACCEPT_TOOLS_MODE_ID = "accept-tools";
/**
 * Auto-apply edits + auto-approve tool permissions
 * (`agy --mode accept-edits --dangerously-skip-permissions`).
 */
export const ACCEPT_EDITS_TOOLS_MODE_ID = "accept-edits-tools";

/** @deprecated Use ACCEPT_TOOLS_MODE_ID. */
export const BYPASS_MODE_ID = ACCEPT_TOOLS_MODE_ID;
/** @deprecated Use ACCEPT_EDITS_TOOLS_MODE_ID. */
export const ACCEPT_EDITS_UNSAFE_MODE_ID = ACCEPT_EDITS_TOOLS_MODE_ID;

/** User-selectable agent mode presets (UI source of truth). */
export const MODE_VALUES = [
	DEFAULT_MODE_ID,
	ACCEPT_EDITS_MODE_ID,
	PLAN_MODE_ID,
	SANDBOX_MODE_ID,
	ACCEPT_TOOLS_MODE_ID,
	ACCEPT_EDITS_TOOLS_MODE_ID,
] as const;

export type ModeValue = (typeof MODE_VALUES)[number];

export const DEFAULT_EFFORT = "medium";
export const EFFORT_VALUES = ["low", "medium", "high"] as const;

export const ON_OFF_VALUES = ["off", "on"] as const;

/** Legacy / alias ids that mean accept-tools (skip tool permissions only). */
export const ACCEPT_TOOLS_ALIASES = new Set([
	ACCEPT_TOOLS_MODE_ID,
	"bypassPermissions",
	"bypass",
	"dontAsk",
	"skip-permissions",
	"skip_permissions",
]);

/** Legacy / alias ids that mean accept-edits + accept-tools. */
export const ACCEPT_EDITS_TOOLS_ALIASES = new Set([
	ACCEPT_EDITS_TOOLS_MODE_ID,
	"accept-edits-unsafe",
]);

/** @deprecated Use ACCEPT_TOOLS_ALIASES. */
export const BYPASS_MODE_ALIASES = ACCEPT_TOOLS_ALIASES;

/** Flags derived from a Mode preset for `agy` invocation. */
export interface ModeFlags {
	/** Value for `agy --mode` when set (default mode omits the flag). */
	agyMode: string | null;
	sandbox: boolean;
	skipPermissions: boolean;
}

/** Map a Mode preset (or legacy alias) to concrete `agy` flags. */
export function resolveModeFlags(mode: string | null | undefined): ModeFlags {
	const m = mode?.trim() || DEFAULT_MODE_ID;

	if (ACCEPT_TOOLS_ALIASES.has(m)) {
		return { agyMode: null, sandbox: false, skipPermissions: true };
	}
	if (ACCEPT_EDITS_TOOLS_ALIASES.has(m)) {
		return {
			agyMode: ACCEPT_EDITS_MODE_ID,
			sandbox: false,
			skipPermissions: true,
		};
	}

	switch (m) {
		case ACCEPT_EDITS_MODE_ID:
			return {
				agyMode: ACCEPT_EDITS_MODE_ID,
				sandbox: false,
				skipPermissions: false,
			};
		case PLAN_MODE_ID:
			return { agyMode: PLAN_MODE_ID, sandbox: false, skipPermissions: false };
		case SANDBOX_MODE_ID:
			return { agyMode: null, sandbox: true, skipPermissions: false };
		default:
			return { agyMode: null, sandbox: false, skipPermissions: false };
	}
}

/**
 * Canonicalize a stored/legacy mode (+ optional independent safety flags)
 * into one Mode preset id for the UI.
 */
export function canonicalizeMode(
	mode: string | null | undefined,
	sandbox = false,
	skipPermissions = false,
): string {
	const m = mode?.trim() || null;

	if (m && ACCEPT_TOOLS_ALIASES.has(m)) return ACCEPT_TOOLS_MODE_ID;
	if (m && ACCEPT_EDITS_TOOLS_ALIASES.has(m)) return ACCEPT_EDITS_TOOLS_MODE_ID;
	if (m === SANDBOX_MODE_ID) return SANDBOX_MODE_ID;
	if (m === PLAN_MODE_ID) return PLAN_MODE_ID;
	if (m === ACCEPT_EDITS_MODE_ID) {
		// Old sessions may have accept-edits + skipPermissions separate.
		return skipPermissions
			? ACCEPT_EDITS_TOOLS_MODE_ID
			: ACCEPT_EDITS_MODE_ID;
	}

	// Default / unknown mode: fold leftover independent safety flags into a preset.
	if (skipPermissions) return ACCEPT_TOOLS_MODE_ID;
	if (sandbox) return SANDBOX_MODE_ID;
	return DEFAULT_MODE_ID;
}

export const AUTH_METHOD_ID = "agy-agent";

export const AVAILABLE_COMMANDS = [
	{ name: "goal", description: "Run a long-running task thoroughly" },
	{
		name: "schedule",
		description: "Run an instruction on a recurring schedule or set a timer",
	},
	{
		name: "grill-me",
		description: "Align on a plan through an interactive interview",
	},
	{
		name: "teamwork-preview",
		description: "Preview a team of autonomous agents working together",
	},
	{ name: "learn", description: "Persist a behavior for future tasks" },
];

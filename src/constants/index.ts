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
export const SANDBOX_CONFIG_ID = "sandbox";
export const SKIP_PERMISSIONS_CONFIG_ID = "skip_permissions";

export const DEFAULT_MODE_ID = "default";
export const ACCEPT_EDITS_MODE_ID = "accept-edits";
export const BYPASS_MODE_ID = "bypassPermissions";
export const PLAN_MODE_ID = "plan";

export const MODE_VALUES = [
	DEFAULT_MODE_ID,
	ACCEPT_EDITS_MODE_ID,
	PLAN_MODE_ID,
	BYPASS_MODE_ID,
] as const;

export const DEFAULT_EFFORT = "medium";
export const EFFORT_VALUES = ["low", "medium", "high"] as const;

export const ON_OFF_VALUES = ["off", "on"] as const;

/** Modes that map to --dangerously-skip-permissions (legacy + current). */
export const BYPASS_MODES = new Set([
	BYPASS_MODE_ID,
	"bypass",
	"dontAsk",
]);

/** Modes passed through to `agy --mode` (default is omitted). */
export const AGY_NATIVE_MODES = new Set([ACCEPT_EDITS_MODE_ID, PLAN_MODE_ID]);

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

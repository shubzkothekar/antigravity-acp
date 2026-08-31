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
export const DEFAULT_MODE_ID = "default";
export const BYPASS_MODE_ID = "bypassPermissions";
export const PLAN_MODE_ID = "plan";

export const PLAN_MODE_INJECTION =
	"<system>\n[PLANNING MODE] You must NOT write, edit, create, move, or execute any files or " +
	"commands. You may only read, search, and explore. Your response must be a clear.\n" +
	"Exception: You can run commands and fetch data from the web which lets you explore, read, search and collect " +
	"more information for creating a plan. " +
	"You can use a tool to write a step - by - step implementation plan for how to accomplish the following task " +
	"— strictly do not start implementing it:\n<system>\n";

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
	{ name: "usage", description: "Display raw token usage and quota metrics" },
];

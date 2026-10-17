// Hand the ACP session's MCP servers to agy.
//
// agy has no per-run MCP flag: it loads MCP servers only from its global
// mcp_config.json or from plugins under a customization root
// (`<root>/.agents/plugins/<name>/mcp_config.json`). It does treat every
// `--add-dir` root as such a root, so each session gets a private folder
// holding a one-plugin `.agents/plugins/acp-session/` with that session's
// servers, and the folder is passed to agy with `--add-dir`. Nothing global is
// touched, and two sessions never see each other's servers or tokens.
//
// Folders are named `<pid>-<sessionId>` so a later process can tell which ones
// a dead adapter left behind and remove them (see sweepStale).
//
// Where they live matters: agy sorts its workspaces (cwd plus every --add-dir)
// by path and tells the model the first one is its "Command Working
// Directory". A folder under ~/.agy-acp sorts before ~/Dev/<project> and so
// became the agent's default cwd. The OS temp dir (/var/folders/... on macOS,
// /tmp on Linux) sorts after /Users and /home, and the `~` in the folder name
// sorts after any letter, for a cwd that is itself in the temp dir.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where per-session plugin folders live: private to this user, in the OS
 *  temp dir (see above for why not under ~/.agy-acp). */
export const MCP_SESSIONS_DIR = path.join(
	os.tmpdir(),
	`~agy-acp-mcp-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
);

/** Plugin name agy sees; its tools are namespaced as `acp-session_<server>`. */
export const PLUGIN_NAME = "acp-session";

/** The servers' file, relative to a session folder. */
const CONFIG_PATH = [".agents", "plugins", PLUGIN_NAME, "mcp_config.json"];

/** An ACP stdio MCP server (the transport every ACP agent must support). */
export interface StdioMcpServer {
	name: string;
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
}

/** Keep only the stdio servers from an ACP `mcpServers` list. HTTP and SSE
 *  servers are not passed on yet (mcpCapabilities says so); each one skipped
 *  is reported through `warn`. */
export function stdioServers(
	list: unknown,
	warn: (msg: string) => void = console.error,
): StdioMcpServer[] {
	if (!Array.isArray(list)) return [];
	const out: StdioMcpServer[] = [];
	for (const raw of list) {
		const s = raw as Record<string, unknown>;
		const name = typeof s?.name === "string" ? s.name : "";
		if (s?.type === "http" || s?.type === "sse" || "url" in (s ?? {})) {
			warn(`[agy-acp] skipping MCP server "${name}": only stdio is supported`);
			continue;
		}
		if (!name || typeof s.command !== "string" || !s.command) {
			warn(`[agy-acp] skipping malformed MCP server "${name}"`);
			continue;
		}
		const args = Array.isArray(s.args)
			? s.args.filter((a): a is string => typeof a === "string")
			: [];
		const env = Array.isArray(s.env)
			? (s.env as Array<Record<string, unknown>>)
					.filter(
						(e) => typeof e?.name === "string" && typeof e?.value === "string",
					)
					.map((e) => ({ name: e.name as string, value: e.value as string }))
			: [];
		out.push({ name, command: s.command, args, env });
	}
	return out;
}

/** The mcp_config.json agy expects, for a list of stdio servers. */
export function toAgyMcpConfig(servers: StdioMcpServer[]): {
	mcpServers: Record<
		string,
		{ command: string; args: string[]; env: Record<string, string> }
	>;
} {
	const mcpServers: Record<
		string,
		{ command: string; args: string[]; env: Record<string, string> }
	> = {};
	for (const s of servers) {
		mcpServers[s.name] = {
			command: s.command,
			args: s.args,
			env: Object.fromEntries(s.env.map((e) => [e.name, e.value])),
		};
	}
	return { mcpServers };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Per-session plugin folders for this adapter process. */
export class SessionMcpPlugins {
	private readonly sessions = new Map<
		string,
		{ root: string; servers: StdioMcpServer[] }
	>();

	constructor(
		private readonly baseDir: string = MCP_SESSIONS_DIR,
		private readonly pid: number = process.pid,
	) {}

	/** The folder to pass to agy with --add-dir, or null if the session has no
	 *  MCP servers. The OS may clean its temp dir while a session is idle, so a
	 *  missing folder is written again here, before each prompt. */
	root(sessionId: string): string | null {
		const entry = this.sessions.get(sessionId);
		if (!entry) return null;
		if (!fs.existsSync(path.join(entry.root, ...CONFIG_PATH))) {
			this.write(entry.root, entry.servers);
		}
		return entry.root;
	}

	/** Write (or replace) a session's servers. An empty list removes them. */
	set(sessionId: string, servers: StdioMcpServer[]): string | null {
		this.remove(sessionId);
		if (servers.length === 0) return null;

		const root = path.join(this.baseDir, `${this.pid}-${safeName(sessionId)}`);
		this.write(root, servers);
		this.sessions.set(sessionId, { root, servers });
		return root;
	}

	private write(root: string, servers: StdioMcpServer[]): void {
		this.ensureBaseDir();
		const pluginDir = path.join(root, ".agents", "plugins", PLUGIN_NAME);
		fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			path.join(pluginDir, "plugin.json"),
			JSON.stringify({ name: PLUGIN_NAME }),
			{ mode: 0o600 },
		);
		// Holds tokens from the client's env: readable by the user only.
		fs.writeFileSync(
			path.join(root, ...CONFIG_PATH),
			JSON.stringify(toAgyMcpConfig(servers), null, 2),
			{ mode: 0o600 },
		);
	}

	/** Create the base folder, private to this user. On Linux it sits in the
	 *  shared /tmp, so refuse one that is a symlink or belongs to someone else
	 *  rather than write tokens into it. */
	private ensureBaseDir(): void {
		fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
		const st = fs.lstatSync(this.baseDir);
		const uid = typeof process.getuid === "function" ? process.getuid() : null;
		if (!st.isDirectory() || (uid !== null && st.uid !== uid)) {
			throw new Error(`${this.baseDir} is not a private folder of this user`);
		}
		if (uid !== null && (st.mode & 0o077) !== 0) {
			fs.chmodSync(this.baseDir, 0o700);
		}
	}

	/** Remove a session's folder, if it has one. */
	remove(sessionId: string): void {
		const entry = this.sessions.get(sessionId);
		if (!entry) return;
		this.sessions.delete(sessionId);
		fs.rmSync(entry.root, { recursive: true, force: true });
	}

	/** Remove every folder this process wrote (on shutdown). */
	removeAll(): void {
		for (const id of [...this.sessions.keys()]) {
			try {
				this.remove(id);
			} catch {
				// best effort; sweepStale picks up what is left
			}
		}
	}

	/** Remove folders left by adapter processes that are no longer running. */
	sweepStale(alive: (pid: number) => boolean = isAlive): void {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.baseDir);
		} catch {
			return;
		}
		for (const name of entries) {
			const pid = Number(name.split("-", 1)[0]);
			if (!Number.isInteger(pid) || pid <= 0) continue;
			if (pid === this.pid || alive(pid)) continue;
			try {
				fs.rmSync(path.join(this.baseDir, name), {
					recursive: true,
					force: true,
				});
			} catch {
				// ignore; try again next start
			}
		}
	}
}

/** Session ids come from the client; keep them to one safe path segment. */
function safeName(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

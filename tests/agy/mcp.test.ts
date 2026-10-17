import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	MCP_SESSIONS_DIR,
	PLUGIN_NAME,
	SessionMcpPlugins,
	stdioServers,
	toAgyMcpConfig,
} from "../../src/agy/mcp";

const bridge = {
	name: "bb",
	command: "/usr/local/bin/node",
	args: ["/bb/bridge.js", "--stdio"],
	env: [
		{ name: "BB_THREAD_ID", value: "thr_1" },
		{ name: "BB_TOKEN", value: "secret-1" },
	],
};

describe("stdioServers()", () => {
	test("keeps stdio servers with their args and env", () => {
		expect(stdioServers([bridge], () => {})).toEqual([bridge]);
	});

	test("skips http and sse servers, saying so", () => {
		const warnings: string[] = [];
		const out = stdioServers(
			[
				{ type: "http", name: "web", url: "https://x/mcp", headers: [] },
				{ type: "sse", name: "old", url: "https://x/sse", headers: [] },
				bridge,
			],
			(m) => warnings.push(m),
		);
		expect(out.map((s) => s.name)).toEqual(["bb"]);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("web");
	});

	test("skips malformed entries and tolerates a missing list", () => {
		const warnings: string[] = [];
		expect(
			stdioServers([{ name: "x" }, { command: "y" }, null], (m) =>
				warnings.push(m),
			),
		).toEqual([]);
		expect(warnings).toHaveLength(3);
		expect(stdioServers(undefined, () => {})).toEqual([]);
	});

	test("defaults missing args and env", () => {
		expect(stdioServers([{ name: "a", command: "c" }], () => {})).toEqual([
			{ name: "a", command: "c", args: [], env: [] },
		]);
	});
});

describe("toAgyMcpConfig()", () => {
	test("maps ACP env pairs to agy's env object", () => {
		expect(toAgyMcpConfig([bridge])).toEqual({
			mcpServers: {
				bb: {
					command: "/usr/local/bin/node",
					args: ["/bb/bridge.js", "--stdio"],
					env: { BB_THREAD_ID: "thr_1", BB_TOKEN: "secret-1" },
				},
			},
		});
	});
});

describe("SessionMcpPlugins", () => {
	let base: string;

	beforeEach(() => {
		base = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-mcp-test-"));
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	const configOf = (root: string) =>
		JSON.parse(
			fs.readFileSync(
				path.join(root, ".agents", "plugins", PLUGIN_NAME, "mcp_config.json"),
				"utf-8",
			),
		);

	test("writes a one-plugin folder agy can load, private to the user", () => {
		const plugins = new SessionMcpPlugins(base, 4242);
		const root = plugins.set("s1", stdioServers([bridge]));
		expect(root).toBe(path.join(base, "4242-s1"));
		expect(plugins.root("s1")).toBe(root);

		const pluginDir = path.join(root!, ".agents", "plugins", PLUGIN_NAME);
		expect(
			JSON.parse(fs.readFileSync(path.join(pluginDir, "plugin.json"), "utf-8")),
		).toEqual({ name: PLUGIN_NAME });
		expect(configOf(root!).mcpServers.bb.env.BB_TOKEN).toBe("secret-1");
		if (process.platform !== "win32") {
			const mode = fs.statSync(path.join(pluginDir, "mcp_config.json")).mode;
			expect(mode & 0o077).toBe(0);
		}
	});

	test("two sessions get separate folders with only their own servers", () => {
		const plugins = new SessionMcpPlugins(base, 1);
		const other = {
			...bridge,
			env: [
				{ name: "BB_THREAD_ID", value: "thr_2" },
				{ name: "BB_TOKEN", value: "secret-2" },
			],
		};
		const a = plugins.set("a", stdioServers([bridge]));
		const b = plugins.set("b", stdioServers([other]));
		expect(a).not.toBe(b);
		expect(configOf(a!).mcpServers.bb.env.BB_TOKEN).toBe("secret-1");
		expect(configOf(b!).mcpServers.bb.env.BB_TOKEN).toBe("secret-2");

		plugins.remove("a");
		expect(fs.existsSync(a!)).toBe(false);
		expect(fs.existsSync(b!)).toBe(true);
	});

	test("set replaces a session's servers; an empty list removes them", () => {
		const plugins = new SessionMcpPlugins(base, 1);
		const first = plugins.set("s", stdioServers([bridge]));
		const renamed = { ...bridge, name: "bb2" };
		const second = plugins.set("s", stdioServers([renamed]));
		expect(Object.keys(configOf(second!).mcpServers)).toEqual(["bb2"]);
		expect(first).toBe(second);

		expect(plugins.set("s", [])).toBeNull();
		expect(plugins.root("s")).toBeNull();
		expect(fs.existsSync(second!)).toBe(false);
	});

	test("removeAll removes every folder this process wrote", () => {
		const plugins = new SessionMcpPlugins(base, 1);
		plugins.set("a", stdioServers([bridge]));
		plugins.set("b", stdioServers([bridge]));
		plugins.removeAll();
		expect(fs.readdirSync(base)).toEqual([]);
	});

	test("sweepStale removes folders of dead processes only", () => {
		new SessionMcpPlugins(base, 111).set("dead", stdioServers([bridge]));
		new SessionMcpPlugins(base, 222).set("alive", stdioServers([bridge]));
		const mine = new SessionMcpPlugins(base, 333);
		mine.set("mine", stdioServers([bridge]));
		fs.mkdirSync(path.join(base, "not-a-pid"));

		mine.sweepStale((pid) => pid === 222);
		expect(fs.readdirSync(base).sort()).toEqual(
			["222-alive", "333-mine", "not-a-pid"].sort(),
		);
	});

	test("sweepStale tolerates a missing base folder", () => {
		const plugins = new SessionMcpPlugins(path.join(base, "nope"), 1);
		expect(() => plugins.sweepStale()).not.toThrow();
	});

	test("session ids are kept to one path segment", () => {
		const plugins = new SessionMcpPlugins(base, 1);
		const root = plugins.set("../../evil", stdioServers([bridge]));
		expect(path.dirname(root!)).toBe(base);
	});

	test("root() writes the folder again if the OS cleaned it", () => {
		const plugins = new SessionMcpPlugins(base, 1);
		const root = plugins.set("s", stdioServers([bridge]))!;
		fs.rmSync(path.join(base), { recursive: true, force: true });
		expect(plugins.root("s")).toBe(root);
		expect(configOf(root).mcpServers.bb.env.BB_TOKEN).toBe("secret-1");
	});

	if (process.platform !== "win32") {
		test("refuses a base folder that is a symlink", () => {
			const target = path.join(base, "target");
			fs.mkdirSync(target);
			const link = path.join(base, "link");
			fs.symlinkSync(target, link);
			const plugins = new SessionMcpPlugins(link, 1);
			expect(() => plugins.set("s", stdioServers([bridge]))).toThrow();
			expect(fs.readdirSync(target)).toEqual([]);
		});
	}
});

describe("MCP_SESSIONS_DIR", () => {
	// agy sorts its workspaces by path and makes the first the agent's working
	// directory: the plugin folder must sort after the user's project.
	test("sorts after typical project folders", () => {
		const projects = [
			path.join(os.homedir(), "Dev", "proj"),
			path.join(os.homedir(), ".config", "proj"),
			path.join(os.tmpdir(), "proj"),
		];
		for (const p of projects) {
			expect([MCP_SESSIONS_DIR, p].sort()[0]).toBe(p);
		}
	});
});

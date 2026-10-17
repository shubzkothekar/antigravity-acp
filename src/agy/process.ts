// Spawning and querying the agy CLI via Bun's native process APIs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Linux MAX_ARG_STRLEN is 128KB; stay well below it to prevent E2BIG errors.
export const MAX_PROMPT_ARG_LENGTH = 64 * 1024;

/**
 * Prepares the prompt argument for agy CLI.
 * If the prompt is too large for a CLI argument (>64KB), offload it to a temp
 * file to prevent E2BIG (argument list too long) spawn errors.
 */
export function preparePromptArg(
	prompt: string,
	sessionId?: string,
): { promptArg: string; tempFilePath?: string } {
	if (prompt.length <= MAX_PROMPT_ARG_LENGTH) {
		return { promptArg: prompt };
	}
	const tempDir = os.tmpdir();
	const filename = `agy-prompt-${sessionId ?? "turn"}-${Date.now()}.md`;
	const tempFilePath = path.join(tempDir, filename);
	fs.writeFileSync(tempFilePath, prompt, "utf-8");
	const promptArg = `Please read the prompt and context in ${tempFilePath} using view_file and follow the instructions in it.`;
	return { promptArg, tempFilePath };
}

export interface DiscoveredModel {
	value: string;
	name: string;
}

/** Query agy for the list of available models (empty on any failure).
 *  Uses async spawn to avoid blocking the event loop (~5s for `agy models`). */
export async function discoverModels(binary: string): Promise<DiscoveredModel[]> {
	try {
		const proc = Bun.spawn([binary, "models"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const text = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return [];
		return text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => {
				const parts = line.split(/\s+/);
				const value = parts[0] ?? "";
				const name = parts.length > 1 ? parts.slice(1).join(" ") : value;
				return { value, name };
			});
	} catch {
		return [];
	}
}

export interface AgyArgsOptions {
	workingDir: string;
	/** Extra workspace roots to add via --add-dir (in addition to workingDir). */
	additionalDirs?: string[];
	conversationId: string | null;
	modelId: string | null;
	permissionMode: string | null;
	/** Whether sandbox mode with terminal restrictions is enabled. */
	sandbox?: boolean;
	prompt: string;
	/** Extra args from $AGY_EXTRA_ARGS, already split. */
	extraArgs?: string[];
	/** Folder holding the session's MCP plugin (see agy/mcp.ts), if any. agy
	 *  loads `.agents/plugins/` from every --add-dir root. */
	mcpRoot?: string | null;
}

/** Build the agy CLI argument vector for a single prompt turn. */
export function buildAgyArgs(opts: AgyArgsOptions): string[] {
	const args = ["--add-dir", opts.workingDir];
	for (const dir of opts.additionalDirs ?? []) {
		args.push("--add-dir", dir);
	}
	if (opts.mcpRoot) args.push("--add-dir", opts.mcpRoot);
	if (opts.conversationId) args.push("--conversation", opts.conversationId);
	if (opts.modelId) args.push("--model", opts.modelId);
	if (opts.permissionMode === "plan") {
		args.push("--mode", "plan");
	} else {
		args.push("--mode", "accept-edits");
	}
	// Always skip permissions in ACP mode — there is no interactive
	// terminal for the user to approve tool calls.
	args.push("--dangerously-skip-permissions");
	if (opts.sandbox) {
		args.push("--sandbox");
	}
	args.push("--print-timeout", "0");
	if (opts.extraArgs?.length) args.push(...opts.extraArgs);
	args.push("-p", opts.prompt);
	return args;
}

/** Spawn agy for a prompt. stdout is ignored (agy persists to its DB); stderr is
 *  piped so the caller can surface failures. */
export function spawnAgy(
	binary: string,
	args: string[],
	cwd: string,
): Bun.Subprocess<"ignore", "ignore", "pipe"> {
	return Bun.spawn([binary, ...args], {
		cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
}

/** Read $AGY_EXTRA_ARGS into a token list. */
export function extraArgsFromEnv(): string[] {
	const raw = process.env.AGY_EXTRA_ARGS;
	return raw ? raw.split(/\s+/).filter((s) => s.length > 0) : [];
}

/** Execute a non-interactive agy command (print mode `-p`) and capture stdout. */
export async function runNonInteractivePrompt(
	binary: string,
	prompt: string,
	cwd?: string,
): Promise<string> {
	try {
		const proc = Bun.spawn([binary, "-p", prompt], {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const text = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return "";
		return text.trim();
	} catch {
		return "";
	}
}

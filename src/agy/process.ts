// Spawning and querying the agy CLI.

import { DEFAULT_EFFORT, resolveModeFlags } from "../constants";
import { runCapture, spawnProcess, type SpawnedProcess } from "../utils/process";

/** Query agy for the list of available model ids (empty on any failure). */
export async function discoverModels(binary: string): Promise<string[]> {
	try {
		const { exitCode, stdout } = await runCapture(binary, ["models"]);
		if (exitCode !== 0) return [];
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
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
	/**
	 * Agent mode preset. Expanded via `resolveModeFlags` into `--mode`,
	 * `--sandbox`, and/or `--dangerously-skip-permissions`.
	 */
	permissionMode: string | null;
	/** Reasoning effort low|medium|high (default medium). */
	effort?: string | null;
	/**
	 * @deprecated Prefer encoding safety in `permissionMode`. Still OR'd with
	 * the mode-derived sandbox flag for old callers/sessions.
	 */
	sandbox?: boolean;
	/**
	 * @deprecated Prefer encoding safety in `permissionMode`. Still OR'd with
	 * the mode-derived skip flag for old callers/sessions.
	 */
	skipPermissions?: boolean;
	prompt: string;
	/** Extra args from $AGY_EXTRA_ARGS, already split. */
	extraArgs?: string[];
}

/** Build the agy CLI argument vector for a single prompt turn. */
export function buildAgyArgs(opts: AgyArgsOptions): string[] {
	const args = ["--add-dir", opts.workingDir];
	for (const dir of opts.additionalDirs ?? []) {
		args.push("--add-dir", dir);
	}
	if (opts.extraArgs?.length) args.push(...opts.extraArgs);
	if (opts.conversationId) args.push("--conversation", opts.conversationId);
	if (opts.modelId) args.push("--model", opts.modelId);

	const flags = resolveModeFlags(opts.permissionMode);
	if (flags.agyMode) args.push("--mode", flags.agyMode);

	const effort = opts.effort?.trim() || DEFAULT_EFFORT;
	args.push("--effort", effort);

	// Mode preset is authoritative; legacy explicit flags still enable if set.
	if (flags.sandbox || opts.sandbox) args.push("--sandbox");
	if (flags.skipPermissions || opts.skipPermissions) {
		args.push("--dangerously-skip-permissions");
	}

	args.push("-p", opts.prompt);
	return args;
}

/** Spawn agy for a prompt. stdout is ignored (agy persists to its DB); stderr is
 *  piped so the caller can surface failures. */
export function spawnAgy(
	binary: string,
	args: string[],
	cwd: string,
): SpawnedProcess {
	return spawnProcess(binary, args, {
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

import path from "node:path";
import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type {
	ErrorDetails,
	PermissionInfo,
	TaskDetails,
} from "../conversation/columns";
import type { StepRow } from "../types";

/**
 * Parse the JSON-encoded tool arguments (`toolRun.call.rawInputJson`) from a
 * step, tolerating missing or malformed payloads. Every tool builder needs
 * these args, so the parse lives here once.
 */
export function parseRawInput(stepRow: StepRow): unknown {
	const rawJson = stepRow.stepPayload.toolRun?.call?.rawInputJson;
	if (typeof rawJson === "string" && rawJson.trim().length > 0) {
		try {
			return JSON.parse(rawJson);
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * Stable tool-call id for a step: the agy-assigned call id when present, else a
 * synthetic id derived from the step's position and type.
 */
export function toolCallId(stepRow: StepRow): string {
	return (
		stepRow.stepPayload.toolRun?.call?.callId ??
		`agy-${stepRow.idx}-${stepRow.stepType}`
	);
}

/**
 * Map the agy step `status` enum to an ACP tool_call status.
 *   2 = in progress, 3 = completed, 6 = cancelled/aborted, 7 = failed.
 * Unknown values default to "completed" (the overwhelmingly common case).
 */
export function toolCallStatus(
	stepRow: StepRow,
): "in_progress" | "completed" | "failed" {
	switch (stepRow.status) {
		case 2:
			return "in_progress";
		case 6:
		case 7:
			return "failed";
		default:
			return "completed";
	}
}

/** A plain text content block for a tool call. */
export function textBlock(text: string): Record<string, unknown> {
	return { type: "content", content: { type: "text", text } };
}

/** A fenced-code-block text content block for a tool call. */
export function codeBlock(text: string): Record<string, unknown> {
	return textBlock(fencedCodeBlock(text));
}

/** Render a decoded `error_details` blob as a content block. */
function errorBlock(e: ErrorDetails): Record<string, unknown> {
	const msg = e.message.trim() || e.detail.trim() || "Tool call failed";
	const detail =
		e.detail.trim() && e.detail.trim() !== msg ? `\n${e.detail.trim()}` : "";
	return codeBlock(`Error: ${msg}${detail}`);
}

/** Render a decoded `permissions` blob as a content block. */
function permissionBlock(p: PermissionInfo): Record<string, unknown> {
	const target = p.value.trim() ? ` (${p.value.trim()})` : "";
	return textBlock(`Permission requested: ${p.kind || "unknown"}${target}`);
}

/** Render a decoded `task_details` blob as a content block. */
function taskBlock(t: TaskDetails): Record<string, unknown> {
	const lines: string[] = [];
	if (t.description) lines.push(t.description);
	if (t.taskId) lines.push(`Task: ${t.taskId}`);
	if (t.logUri) lines.push(`Log: ${t.logUri}`);
	return textBlock(lines.join("\n"));
}

/**
 * Build a `tool_call` session update with the common envelope. Every tool step
 * flows through here, so this is also where the auxiliary columns are surfaced:
 * the parsed args become `rawInput`, a decoded `error_details` becomes
 * `rawOutput` plus a content block, and `permissions` / `task_details` are
 * appended as content. Status defaults to the mapped step status.
 */
export function toolCallUpdate(opts: {
	stepRow: StepRow;
	title: string;
	kind: ToolKind;
	status?: "pending" | "in_progress" | "completed" | "failed";
	content?: Record<string, unknown>[];
	locations?: Record<string, unknown>[];
}): SessionUpdate {
	const {
		stepRow,
		title,
		kind,
		status = toolCallStatus(stepRow),
		content,
		locations,
	} = opts;

	const blocks: Record<string, unknown>[] = [...(content ?? [])];
	if (stepRow.task) blocks.push(taskBlock(stepRow.task));
	if (stepRow.permission) blocks.push(permissionBlock(stepRow.permission));
	if (stepRow.error) blocks.push(errorBlock(stepRow.error));

	const rawInput = parseRawInput(stepRow);
	const rawOutput = stepRow.error
		? {
				message: stepRow.error.message || stepRow.error.detail,
				detail: stepRow.error.detail,
				stackTrace: stepRow.error.stackTrace,
			}
		: undefined;

	return {
		sessionUpdate: "tool_call",
		toolCallId: toolCallId(stepRow),
		title,
		kind,
		status,
		...(blocks.length > 0 ? { content: blocks } : {}),
		...(locations && locations.length > 0 ? { locations } : {}),
		...(rawInput != null ? { rawInput } : {}),
		...(rawOutput != null ? { rawOutput } : {}),
	} as SessionUpdate;
}

/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
	if (!cwd) return filePath;
	const resolvedCwd = path.resolve(cwd);
	const resolvedFile = path.resolve(filePath);
	if (
		resolvedFile.startsWith(resolvedCwd + path.sep) ||
		resolvedFile === resolvedCwd
	) {
		return path.relative(resolvedCwd, resolvedFile).split(path.sep).join("/");
	}
	return filePath;
}

export function fencedCodeBlock(text: string): string {
	let fenceLen = 3;
	let run = 0;
	for (const ch of text) {
		run = ch === "`" ? run + 1 : 0;
		fenceLen = Math.max(fenceLen, run + 1);
	}
	const fence = "`".repeat(fenceLen);
	return `${fence}\n${text}\n${fence}`;
}

export function toolKind(name: string): ToolKind {
	const l = name.toLowerCase();
	if (
		l.includes("write") ||
		l.includes("edit") ||
		l.includes("patch") ||
		l.includes("replace")
	)
		return "edit";
	if (l.includes("delete") || l.includes("remove")) return "delete";
	if (l.includes("move") || l.includes("rename")) return "move";
	if (l.includes("read") || l.includes("view") || l.includes("list"))
		return "read";
	if (l.includes("grep") || l.includes("search") || l.includes("find"))
		return "search";
	if (l.includes("command") || l.includes("execute") || l.includes("terminal"))
		return "execute";
	if (
		l.includes("think") ||
		l.includes("thought") ||
		l.includes("reason") ||
		l.includes("plan")
	)
		return "think";
	if (l.includes("url") || l.includes("fetch")) return "fetch";
	return "other";
}

export function pick(o: unknown, ...keys: string[]): unknown {
	if (
		o === null ||
		o === undefined ||
		typeof o !== "object" ||
		Array.isArray(o)
	)
		return undefined;
	for (const k of keys) {
		if (k in o) {
			return (o as Record<string, unknown>)[k];
		}
	}
	return undefined;
}

export function asStr(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

/** Coerce a value that may be a number or numeric string into a number. */
export function asNum(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim().length > 0) {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

/** Strip a `file://` scheme so the value can be resolved/displayed as a path. */
export function fsPath(p: string | null | undefined): string | null {
	if (!p) return null;
	if (p.startsWith("file://")) {
		try {
			return decodeURIComponent(new URL(p).pathname);
		} catch {
			return p.slice("file://".length);
		}
	}
	return p;
}

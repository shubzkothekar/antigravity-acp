// Decoders for the auxiliary `steps` columns that sit alongside `step_payload`:
// `error_details`, `permissions`, and `task_details`. These are separate
// protobuf blobs; the shapes here were reverse-engineered from real agy DBs.
//
// `task_details` matches the generated `TaskDetails` message, so that one is
// reused directly. `error_details` and `permissions` have no generated message
// (the hand-written proto for permissions was inaccurate), so they're decoded
// here with the same BinaryReader the generated code uses.

import { BinaryReader } from "@bufbuild/protobuf/wire";
import { TaskDetails } from "../gen/steps";

export interface ErrorDetails {
	/** Short, user-facing summary (e.g. "User denied permission for command(...)"). */
	message: string;
	/** The underlying error detail / stderr. */
	detail: string;
	/** Full error with attached stack trace. */
	stackTrace: string;
	/** Error ID shown by the Antigravity IDE (field 6), when present. */
	id?: string;
}

/**
 * error_details: { 1: message, 2: detail, 3: stackTrace, 4: flag, 6: id }.
 * f1 is sometimes absent (e.g. cancellations), so callers should fall back to
 * `detail`.
 */
export function decodeErrorDetails(input: Uint8Array): ErrorDetails {
	const r = new BinaryReader(input);
	const out: ErrorDetails = { message: "", detail: "", stackTrace: "" };
	while (r.pos < r.len) {
		const tag = r.uint32();
		switch (tag >>> 3) {
			case 1:
				out.message = r.string();
				break;
			case 2:
				out.detail = r.string();
				break;
			case 3:
				out.stackTrace = r.string();
				break;
			case 6:
				out.id = r.string();
				break;
			default:
				r.skip(tag & 7);
		}
	}
	return out;
}

/**
 * ERROR_MESSAGE steps (step_type 17) carry no `error_details` column; the error
 * sits in step_payload as { 24: { 3: error_details } }. Returns null when absent.
 */
export function decodeErrorMessageStep(input: Uint8Array): ErrorDetails | null {
	const inner = readLengthDelimited(input, 24);
	if (!inner) return null;
	const details = readLengthDelimited(inner, 3);
	return details ? decodeErrorDetails(details) : null;
}

function readLengthDelimited(
	input: Uint8Array,
	field: number,
): Uint8Array | null {
	const r = new BinaryReader(input);
	while (r.pos < r.len) {
		const tag = r.uint32();
		if (tag >>> 3 === field && (tag & 7) === 2) return r.bytes();
		r.skip(tag & 7);
	}
	return null;
}

export interface PermissionInfo {
	/** The permission category, e.g. "command". */
	kind: string;
	/** The target the agent asked permission for, e.g. the command string. */
	value: string;
	/** Raw decision varint as stored by agy (semantics not fully specified). */
	decision: number;
}

/**
 * permissions: nested as
 *   { 2: { 1: { 1: kind, 2: value }, 2: decision } }
 * Returns null when no permission entry is present.
 */
export function decodePermissions(input: Uint8Array): PermissionInfo | null {
	const r = new BinaryReader(input);
	let entry: Uint8Array | null = null;
	while (r.pos < r.len) {
		const tag = r.uint32();
		if (tag >>> 3 === 2 && (tag & 7) === 2) {
			entry = r.bytes();
		} else {
			r.skip(tag & 7);
		}
	}
	if (!entry) return null;

	const er = new BinaryReader(entry);
	let target: Uint8Array | null = null;
	let decision = 0;
	while (er.pos < er.len) {
		const tag = er.uint32();
		const field = tag >>> 3;
		if (field === 1 && (tag & 7) === 2) {
			target = er.bytes();
		} else if (field === 2 && (tag & 7) === 0) {
			decision = Number(er.int64());
		} else {
			er.skip(tag & 7);
		}
	}

	const out: PermissionInfo = { kind: "", value: "", decision };
	if (target) {
		const tr = new BinaryReader(target);
		while (tr.pos < tr.len) {
			const tag = tr.uint32();
			const field = tag >>> 3;
			if (field === 1 && (tag & 7) === 2) {
				out.kind = tr.string();
			} else if (field === 2 && (tag & 7) === 2) {
				out.value = tr.string();
			} else {
				tr.skip(tag & 7);
			}
		}
	}
	return out;
}

/** task_details matches the generated `TaskDetails` message. */
export function decodeTaskDetails(input: Uint8Array): TaskDetails {
	return TaskDetails.decode(input);
}

/**
 * Extract tool execution output from `step_payload` (Field 140 -> Tag 2 -> Tag 1).
 * In modern agy CLI (v1.1+), tool results (stdout, file content, grep hits, etc.)
 * are stored in this protobuf field.
 * Returns null when absent or malformed.
 */
export function decodeToolOutput(input: Uint8Array): string | null {
	if (!input || input.length === 0) return null;
	try {
		const r = new BinaryReader(input);
		while (r.pos < r.len) {
			const tag = r.uint32();
			if (tag >>> 3 === 140 && (tag & 7) === 2) {
				const f140 = r.bytes();
				const f140Reader = new BinaryReader(f140);
				while (f140Reader.pos < f140Reader.len) {
					const sTag = f140Reader.uint32();
					if (sTag >>> 3 === 2 && (sTag & 7) === 2) {
						const t2 = f140Reader.bytes();
						const t2Reader = new BinaryReader(t2);
						while (t2Reader.pos < t2Reader.len) {
							const oTag = t2Reader.uint32();
							if (oTag >>> 3 === 1 && (oTag & 7) === 2) {
								return t2Reader.string();
							}
							t2Reader.skip(oTag & 7);
						}
					} else {
						f140Reader.skip(sTag & 7);
					}
				}
			} else {
				r.skip(tag & 7);
			}
		}
	} catch {
		return null;
	}
	return null;
}

export type { TaskDetails };

/**
 * Model usage for one agy generation, decoded from the step payload.
 *
 * Layout, verified against agy 1.3.5 and Antigravity 2.13.0 databases (the CLI
 * transcript's own `input_tokens` / `output_tokens` / `cache_read_tokens`
 * counters match these fields row for row):
 *   step_payload.5.9.2   fresh (uncached) input tokens
 *   step_payload.5.9.5   input tokens served from the model's context cache
 *   step_payload.5.9.9   reasoning (thinking) output tokens
 *   step_payload.5.9.10  visible output tokens
 * Field 3 holds the total output (9 + 10), so it is not decoded here.
 */
export interface ModelUsage {
	inputTokens: number;
	cacheReadTokens: number;
	reasoningTokens: number;
	visibleOutputTokens: number;
}

/** Decode the model usage block, or null when the step reports none. */
export function decodeModelUsage(input: Uint8Array): ModelUsage | null {
	if (!input || input.length === 0) return null;
	try {
		const r = new BinaryReader(input);
		while (r.pos < r.len) {
			const tag = r.uint32();
			if (tag >>> 3 === 5 && (tag & 7) === 2) {
				const usage = readLengthDelimited(r.bytes(), 9);
				if (!usage) continue;
				const u = new BinaryReader(usage);
				const decoded: ModelUsage = {
					inputTokens: 0,
					cacheReadTokens: 0,
					reasoningTokens: 0,
					visibleOutputTokens: 0,
				};
				while (u.pos < u.len) {
					const uTag = u.uint32();
					if ((uTag & 7) === 0) {
						const value = u.uint32();
						switch (uTag >>> 3) {
							case 2:
								decoded.inputTokens = value;
								break;
							case 5:
								decoded.cacheReadTokens = value;
								break;
							case 9:
								decoded.reasoningTokens = value;
								break;
							case 10:
								decoded.visibleOutputTokens = value;
								break;
						}
					} else {
						u.skip(uTag & 7);
					}
				}
				if (
					decoded.inputTokens ||
					decoded.cacheReadTokens ||
					decoded.reasoningTokens ||
					decoded.visibleOutputTokens
				) {
					return decoded;
				}
			} else {
				r.skip(tag & 7);
			}
		}
	} catch {
		return null;
	}
	return null;
}

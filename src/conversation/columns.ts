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
			default:
				r.skip(tag & 7);
		}
	}
	return out;
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

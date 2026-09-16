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

export type { TaskDetails };

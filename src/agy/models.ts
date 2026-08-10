// Parse `agy models` output, condense effort-variant rows into one UI model,
// and resolve (base model + effort) back to a backend model id.

import { DEFAULT_EFFORT, EFFORT_VALUES } from "../constants";

export type EffortValue = (typeof EFFORT_VALUES)[number];

/** One row from `agy models` (backend id + optional display name). */
export interface ModelEntry {
	/** Backend model id passed to `agy --model` (may include effort suffix). */
	id: string;
	/** Human label from agy, if present. */
	name: string;
}

/** One UI-facing model after collapsing effort variants. */
export interface CondensedModel {
	/** Stable UI / session value (base id without effort suffix). */
	id: string;
	/** Display name without trailing "(Low|Medium|High)". */
	name: string;
	/** Backend ids available for this base, keyed by effort when known. */
	variants: Partial<Record<EffortValue, string>>;
	/** Backend ids that have no recognized effort suffix (always selectable). */
	fixedIds: string[];
}

const EFFORT_SUFFIX_RE = /-(low|medium|high)$/i;
const DISPLAY_EFFORT_RE = /\s*\((low|medium|high)\)\s*$/i;

export function isEffortValue(value: string): value is EffortValue {
	return (EFFORT_VALUES as readonly string[]).includes(value);
}

/** Strip a trailing -low|-medium|-high effort suffix from a backend model id. */
export function stripEffortSuffix(modelId: string): {
	baseId: string;
	effort: EffortValue | null;
} {
	const trimmed = modelId.trim();
	const match = trimmed.match(EFFORT_SUFFIX_RE);
	if (!match) return { baseId: trimmed, effort: null };
	const effort = match[1]!.toLowerCase() as EffortValue;
	return {
		baseId: trimmed.slice(0, -match[0].length),
		effort,
	};
}

/** Remove a trailing "(Low|Medium|High)" label from an agy display name. */
export function stripEffortLabel(name: string): string {
	return name.replace(DISPLAY_EFFORT_RE, "").trim();
}

/**
 * UI label for a catalog row after condensation.
 * Handles both human labels ("Gemini 3.6 Flash (High)") and id-only cache
 * rows ("gemini-3.6-flash-high") so effort never remains in the menu name.
 */
export function uiModelName(entry: ModelEntry, baseId: string): string {
	let name = stripEffortLabel(entry.name.trim() || entry.id);

	// Id-shaped names: strip -low|-medium|-high and fall back to base id.
	const fromId = stripEffortSuffix(name);
	if (fromId.effort) {
		name = fromId.baseId;
	}
	if (!name || name === entry.id) name = baseId;
	return name;
}

/**
 * Parse `agy models` stdout.
 * Supports:
 * - `id` only
 * - `id<whitespace>Display Name`
 * - legacy full-line ids that already include display text (best-effort first token)
 */
export function parseModelsOutput(stdout: string): ModelEntry[] {
	const entries: ModelEntry[] = [];
	const seen = new Set<string>();

	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		// Prefer: first whitespace-separated token is the backend id.
		const match = line.match(/^(\S+)(?:\s+(.*))?$/);
		if (!match) continue;
		const id = match[1]!;
		const name = (match[2] ?? "").trim() || id;
		if (seen.has(id)) continue;
		seen.add(id);
		entries.push({ id, name });
	}

	return entries;
}

/** Collapse effort-suffixed backend rows into one UI model each. */
export function condenseModels(entries: ModelEntry[]): CondensedModel[] {
	const byBase = new Map<string, CondensedModel>();
	const order: string[] = [];

	for (const entry of entries) {
		const { baseId, effort } = stripEffortSuffix(entry.id);
		const label = uiModelName(entry, baseId);
		let condensed = byBase.get(baseId);
		if (!condensed) {
			condensed = {
				id: baseId,
				name: label,
				variants: {},
				fixedIds: [],
			};
			byBase.set(baseId, condensed);
			order.push(baseId);
		} else if (
			// Prefer a human label over a bare/base id when one appears later.
			(condensed.name === condensed.id || condensed.name === baseId) &&
			label !== baseId &&
			label !== entry.id
		) {
			condensed.name = label;
		}

		if (effort) {
			// First-seen variant for an effort wins (catalog order).
			if (!condensed.variants[effort]) {
				condensed.variants[effort] = entry.id;
			}
		} else if (!condensed.fixedIds.includes(entry.id)) {
			condensed.fixedIds.push(entry.id);
		}
	}

	return order.map((id) => byBase.get(id)!);
}

/**
 * Canonicalize a stored/selected model value to a condensed base id.
 * Accepts base ids and effort-suffixed backend ids.
 */
export function canonicalizeModelId(
	modelId: string | null | undefined,
	condensed: CondensedModel[],
): string | null {
	if (!modelId?.trim()) return null;
	const raw = modelId.trim();
	const { baseId } = stripEffortSuffix(raw);

	if (condensed.some((m) => m.id === baseId)) return baseId;
	if (condensed.some((m) => m.id === raw)) return raw;

	// Exact backend id match (including fixed / non-effort ids).
	for (const model of condensed) {
		if (model.fixedIds.includes(raw)) return model.id;
		for (const id of Object.values(model.variants)) {
			if (id === raw) return model.id;
		}
	}

	// Unknown id: still strip effort so session storage stays base-shaped.
	return baseId || raw;
}

/**
 * Map UI model + effort to the backend id for `agy --model`.
 * Preference order:
 * 1. exact effort variant
 * 2. DEFAULT_EFFORT variant
 * 3. medium / high / low (in that order among remaining)
 * 4. any fixed (non-suffixed) id
 * 5. any known variant
 * 6. synthesize `${baseId}-${effort}` when catalog is empty / unknown
 */
export function resolveBackendModelId(
	modelId: string | null | undefined,
	effort: string | null | undefined,
	condensed: CondensedModel[],
): string | null {
	if (!modelId?.trim()) return null;

	const wantedEffort: EffortValue = isEffortValue(effort?.trim() || "")
		? (effort!.trim() as EffortValue)
		: DEFAULT_EFFORT;

	const baseId = canonicalizeModelId(modelId, condensed) ?? modelId.trim();
	const model = condensed.find((m) => m.id === baseId);

	if (!model) {
		// Unknown model: if it already has an effort suffix, keep it; else append.
		const stripped = stripEffortSuffix(modelId.trim());
		if (stripped.effort) return modelId.trim();
		return `${stripped.baseId}-${wantedEffort}`;
	}

	const exact = model.variants[wantedEffort];
	if (exact) return exact;

	const fallbackOrder: EffortValue[] = [
		DEFAULT_EFFORT,
		"medium",
		"high",
		"low",
	];
	const seen = new Set<string>();
	for (const level of fallbackOrder) {
		const id = model.variants[level];
		if (id && !seen.has(id)) {
			seen.add(id);
			return id;
		}
	}

	if (model.fixedIds.length > 0) return model.fixedIds[0]!;

	for (const id of Object.values(model.variants)) {
		if (id) return id;
	}

	return `${model.id}-${wantedEffort}`;
}

/** Convenience: parse + condense in one step. */
export function modelsFromAgyOutput(stdout: string): {
	entries: ModelEntry[];
	condensed: CondensedModel[];
} {
	const entries = parseModelsOutput(stdout);
	return { entries, condensed: condenseModels(entries) };
}

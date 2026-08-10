import { describe, expect, it } from "bun:test";
import {
	canonicalizeModelId,
	condenseModels,
	modelsFromAgyOutput,
	parseModelsOutput,
	resolveBackendModelId,
	stripEffortLabel,
	stripEffortSuffix,
} from "../../src/agy/models";

const SAMPLE_AGY_MODELS = `
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low      Gemini 3.6 Flash (Low)
gemini-3.5-flash-high     Gemini 3.5 Flash (High)
gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)
gemini-3.5-flash-low      Gemini 3.5 Flash (Low)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`.trim();

describe("agy/models.ts", () => {
	describe("stripEffortSuffix()", () => {
		it("strips trailing effort suffixes", () => {
			expect(stripEffortSuffix("gemini-3.6-flash-high")).toEqual({
				baseId: "gemini-3.6-flash",
				effort: "high",
			});
			expect(stripEffortSuffix("gpt-oss-120b-medium")).toEqual({
				baseId: "gpt-oss-120b",
				effort: "medium",
			});
		});

		it("leaves non-effort ids alone", () => {
			expect(stripEffortSuffix("claude-sonnet-4-6")).toEqual({
				baseId: "claude-sonnet-4-6",
				effort: null,
			});
			expect(stripEffortSuffix("claude-opus-4-6-thinking")).toEqual({
				baseId: "claude-opus-4-6-thinking",
				effort: null,
			});
		});
	});

	describe("stripEffortLabel()", () => {
		it("removes trailing (Low|Medium|High)", () => {
			expect(stripEffortLabel("Gemini 3.6 Flash (High)")).toBe(
				"Gemini 3.6 Flash",
			);
			expect(stripEffortLabel("Claude Sonnet 4.6 (Thinking)")).toBe(
				"Claude Sonnet 4.6 (Thinking)",
			);
		});
	});

	describe("parseModelsOutput()", () => {
		it("parses id + display name rows", () => {
			const entries = parseModelsOutput(SAMPLE_AGY_MODELS);
			expect(entries[0]).toEqual({
				id: "gemini-3.6-flash-high",
				name: "Gemini 3.6 Flash (High)",
			});
			expect(entries).toHaveLength(11);
		});

		it("supports id-only lines", () => {
			expect(parseModelsOutput("model-a\nmodel-b\n")).toEqual([
				{ id: "model-a", name: "model-a" },
				{ id: "model-b", name: "model-b" },
			]);
		});
	});

	describe("condenseModels()", () => {
		it("collapses effort variants to one model each", () => {
			const { condensed } = modelsFromAgyOutput(SAMPLE_AGY_MODELS);
			expect(condensed.map((m) => m.id)).toEqual([
				"gemini-3.6-flash",
				"gemini-3.5-flash",
				"gemini-3.1-pro",
				"claude-sonnet-4-6",
				"claude-opus-4-6-thinking",
				"gpt-oss-120b",
			]);
			expect(condensed[0]).toMatchObject({
				id: "gemini-3.6-flash",
				name: "Gemini 3.6 Flash",
				variants: {
					high: "gemini-3.6-flash-high",
					medium: "gemini-3.6-flash-medium",
					low: "gemini-3.6-flash-low",
				},
			});
			expect(condensed[2]).toMatchObject({
				id: "gemini-3.1-pro",
				name: "Gemini 3.1 Pro",
				variants: {
					high: "gemini-3.1-pro-high",
					low: "gemini-3.1-pro-low",
				},
			});
			expect(condensed[3]).toMatchObject({
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4.6 (Thinking)",
				fixedIds: ["claude-sonnet-4-6"],
				variants: {},
			});
		});

		it("strips effort from id-only cache rows (no human labels)", () => {
			const condensed = condenseModels(
				parseModelsOutput(
					[
						"gemini-3.6-flash-high",
						"gemini-3.6-flash-medium",
						"gemini-3.6-flash-low",
						"gpt-oss-120b-medium",
						"claude-sonnet-4-6",
					].join("\n"),
				),
			);
			expect(condensed.map((m) => ({ id: m.id, name: m.name }))).toEqual([
				{ id: "gemini-3.6-flash", name: "gemini-3.6-flash" },
				{ id: "gpt-oss-120b", name: "gpt-oss-120b" },
				{ id: "claude-sonnet-4-6", name: "claude-sonnet-4-6" },
			]);
		});
	});

	describe("canonicalizeModelId()", () => {
		const condensed = condenseModels(parseModelsOutput(SAMPLE_AGY_MODELS));

		it("maps backend and base ids to the condensed base", () => {
			expect(canonicalizeModelId("gemini-3.6-flash-high", condensed)).toBe(
				"gemini-3.6-flash",
			);
			expect(canonicalizeModelId("gemini-3.6-flash", condensed)).toBe(
				"gemini-3.6-flash",
			);
			expect(canonicalizeModelId("claude-sonnet-4-6", condensed)).toBe(
				"claude-sonnet-4-6",
			);
		});
	});

	describe("resolveBackendModelId()", () => {
		const condensed = condenseModels(parseModelsOutput(SAMPLE_AGY_MODELS));

		it("picks the matching effort variant", () => {
			expect(
				resolveBackendModelId("gemini-3.6-flash", "high", condensed),
			).toBe("gemini-3.6-flash-high");
			expect(
				resolveBackendModelId("gemini-3.6-flash-low", "medium", condensed),
			).toBe("gemini-3.6-flash-medium");
		});

		it("falls back when requested effort is missing", () => {
			// gemini-3.1-pro has high + low only; medium → high (DEFAULT then order)
			expect(
				resolveBackendModelId("gemini-3.1-pro", "medium", condensed),
			).toBe("gemini-3.1-pro-high");
		});

		it("uses fixed ids for models without effort variants", () => {
			expect(
				resolveBackendModelId("claude-sonnet-4-6", "high", condensed),
			).toBe("claude-sonnet-4-6");
		});

		it("synthesizes suffix for unknown models", () => {
			expect(resolveBackendModelId("new-model", "low", [])).toBe(
				"new-model-low",
			);
			expect(
				resolveBackendModelId("already-high", "low", []),
			).toBe("already-high");
		});
	});
});

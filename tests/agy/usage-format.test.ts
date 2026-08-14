import { describe, expect, it } from "bun:test";
import { formatUsageOutput } from "../../src/agy/usage-format";

const HOUR = 1000 * 60 * 60;
const DAY = HOUR * 24;

describe("agy/usage-format.ts", () => {
	describe("formatUsageOutput()", () => {
		it("groups rows by model family with headings, bars, and relative reset times", () => {
			const in5Hours = new Date(Date.now() + 5 * HOUR).toISOString();
			const in7Days = new Date(Date.now() + 7 * DAY).toISOString();
			const raw = [
				`Gemini Models\tWeekly Limit Remaining\t98%\t${in7Days}`,
				`Gemini Models\tFive Hour Limit Remaining\t95%\t${in5Hours}`,
				`Claude and GPT models\tWeekly Limit Remaining\t100%\t${in7Days}`,
				`Claude and GPT models\tFive Hour Limit Remaining\t100%\t${in5Hours}`,
			].join("\n");

			const formatted = formatUsageOutput(raw);

			expect(formatted).toContain("### **Gemini Models**");
			expect(formatted).toContain("### **Claude and GPT models**");
			expect(formatted).toContain("## Weekly (Resets in 7 days)");
			expect(formatted).toContain("## Session (Resets in 5 hours)");
			expect(formatted).toContain("█".repeat(30) + " 100% left");
			// 95% of a 30-segment bar rounds to 29 filled, 1 empty.
			expect(formatted).toContain("█".repeat(29) + "░".repeat(1) + " 95% left");
			// 98% of a 30-segment bar rounds to 29 filled, 1 empty (29.4 -> 29).
			expect(formatted).toContain("█".repeat(29) + "░".repeat(1) + " 98% left");
		});

		it("falls back to the raw text when rows don't have 4 columns", () => {
			const raw = "not\ttab\tseparated\ncorrectly";
			expect(formatUsageOutput(raw)).toBe(raw.trim());
		});

		it("falls back to raw values for unparseable timestamps or percentages", () => {
			const raw = "Gemini Models\tWeekly Limit Remaining\tnot-a-percent\tnot-a-date";
			const formatted = formatUsageOutput(raw);
			expect(formatted).toContain("## Weekly (Resets not-a-date)");
			expect(formatted).toContain(" not-a-percent");
		});

		it("returns empty string for empty input", () => {
			expect(formatUsageOutput("")).toBe("");
			expect(formatUsageOutput("   \n  ")).toBe("");
		});
	});
});

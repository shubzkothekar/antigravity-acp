// Formats agy's raw `/usage` output (tab-separated rows of
// group, metric, remaining %, reset timestamp) into a readable card layout.

const BAR_WIDTH = 30;

interface UsageRow {
	group: string;
	metric: string;
	remaining: string;
	resetAt: string;
}

function parseUsageRows(raw: string): UsageRow[] | null {
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return null;

	const rows: UsageRow[] = [];
	for (const line of lines) {
		const cols = line.split("\t").map((col) => col.trim());
		if (cols.length !== 4) return null;
		const [group, metric, remaining, resetAt] = cols;
		if (!group || !metric || !remaining || !resetAt) return null;
		rows.push({ group, metric, remaining, resetAt });
	}
	return rows;
}

function formatRemainingBar(remaining: string): string {
	const percent = Number.parseFloat(remaining);
	if (Number.isNaN(percent)) return remaining;
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * BAR_WIDTH);
	const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
	return `${bar} ${remaining} left`;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	["day", 1000 * 60 * 60 * 24],
	["hour", 1000 * 60 * 60],
	["minute", 1000 * 60],
];

function formatRelativeReset(resetAt: string): string {
	const date = new Date(resetAt);
	if (Number.isNaN(date.getTime())) return resetAt;

	const diffMs = date.getTime() - new Date().getTime();
	const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

	for (const [unit, unitMs] of RELATIVE_UNITS) {
		if (Math.abs(diffMs) >= unitMs) {
			return rtf.format(Math.round(diffMs / unitMs), unit);
		}
	}
	return rtf.format(Math.round(diffMs / (1000 * 60)), "minute");
}

const METRIC_LABELS: Record<string, string> = {
	"Five Hour Limit Remaining": "Session",
	"Weekly Limit Remaining": "Weekly",
};

function shortenMetricLabel(metric: string): string {
	return METRIC_LABELS[metric] ?? metric;
}

/** Turn agy's raw `/usage` stdout into a grouped, human-readable card layout
 *  with progress bars and relative reset times. Returns the raw text
 *  unchanged if it doesn't match the expected tab-separated shape, so a
 *  format change upstream never hides data. */
export function formatUsageOutput(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return trimmed;

	const rows = parseUsageRows(trimmed);
	if (!rows) return trimmed;

	const groups = new Map<string, UsageRow[]>();
	for (const row of rows) {
		const existing = groups.get(row.group);
		if (existing) existing.push(row);
		else groups.set(row.group, [row]);
	}

	const sections: string[] = [];
	for (const [group, groupRows] of groups) {
		const rowBlocks = groupRows.map(
			(row) =>
				`## ${shortenMetricLabel(row.metric)} (Resets ${formatRelativeReset(row.resetAt)})\n ${formatRemainingBar(row.remaining)}`,
		);
		sections.push(`### **${group}**\n\n${rowBlocks.join("\n\n")}`);
	}

	return sections.join("\n\n");
}

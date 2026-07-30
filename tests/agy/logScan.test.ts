import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	decideTurnError,
	detectSwallowedAgyError,
	extractAgyErrorMessage,
	snapshotAgyLogs,
} from "../../src/agy/logScan";

const QUOTA_LOG = `\
I0707 08:34:18.847769  84 http_helpers.go:208] URL: .../streamGenerateContent?alt=sse
E0707 08:34:23.910604  84 log.go:398] agent executor error: model unreachable: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 40h52m46s.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 40h52m46s.
`;

describe("agy/logScan", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-logscan-"));
	const conversations = path.join(root, "conversations");
	const logDir = path.join(root, "log");

	beforeEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
		fs.mkdirSync(conversations, { recursive: true });
		fs.mkdirSync(logDir, { recursive: true });
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("extractAgyErrorMessage dewraps quota errors", () => {
		const msg = extractAgyErrorMessage(QUOTA_LOG);
		expect(msg).toBeTruthy();
		expect(msg!.startsWith("agent executor error:")).toBe(true);
		expect(msg).toContain("Individual quota reached");
		expect(msg).not.toContain(".: ");
	});

	test("extractAgyErrorMessage returns null for clean logs", () => {
		expect(
			extractAgyErrorMessage(
				"I0707 08:34:15.727406  84 printmode.go:225] Print mode: silent auth succeeded\n",
			),
		).toBeNull();
	});

	test("decideTurnError surfaces non-zero exit and swallowed errors", () => {
		expect(
			decideTurnError({
				wasCancelled: false,
				exitCode: 1,
				hadUpdates: false,
				stderrText: "boom",
				swallowedError: null,
			}),
		).toBe("agy failed: boom");

		expect(
			decideTurnError({
				wasCancelled: false,
				exitCode: 0,
				hadUpdates: false,
				stderrText: "",
				swallowedError: "agent executor error: quota",
			}),
		).toBe("agent executor error: quota");

		expect(
			decideTurnError({
				wasCancelled: true,
				exitCode: 1,
				hadUpdates: false,
				stderrText: "x",
				swallowedError: null,
			}),
		).toBeNull();

		expect(
			decideTurnError({
				wasCancelled: false,
				exitCode: 1,
				hadUpdates: true,
				stderrText: "x",
				swallowedError: null,
			}),
		).toBeNull();
	});

	test("detectSwallowedAgyError reads a fresh turn log", () => {
		const spawnTime = new Date();
		fs.writeFileSync(path.join(logDir, "cli-20260707_083407.log"), QUOTA_LOG);
		const detected = detectSwallowedAgyError(
			conversations,
			new Map(),
			spawnTime,
		);
		expect(detected).toBeTruthy();
		expect(detected).toContain("Individual quota reached");
	});

	test("detectSwallowedAgyError ignores pre-snapshot error bytes", () => {
		const logPath = path.join(logDir, "cli-20260707_083407.log");
		fs.writeFileSync(logPath, QUOTA_LOG);
		const snapshot = snapshotAgyLogs(conversations);
		const spawnTime = new Date();
		fs.appendFileSync(logPath, "I0707 09:00:00.000000  84 server.go:825] turn ok\n");
		expect(
			detectSwallowedAgyError(conversations, snapshot, spawnTime),
		).toBeNull();
	});
});

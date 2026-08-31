import { afterEach, describe, expect, test } from "bun:test";
import {
	persistentAgyEnabled,
	promptTimeoutMsFromEnv,
	TerminalStateTracker,
} from "../../src/agy/interactive";

describe("TerminalStateTracker", () => {
	test("recognizes a busy-to-idle turn across split PTY chunks", () => {
		const tracker = new TerminalStateTracker();
		const checkpoint = tracker.checkpoint();

		tracker.feed("esc to can", 1_000);
		tracker.feed("cel", 1_010);
		expect(tracker.turnCompleted(checkpoint, 1_020)).toBe(false);

		tracker.feed("\u001b[2K? for short", 1_100);
		tracker.feed("cuts", 1_110);
		expect(tracker.turnCompleted(checkpoint, 1_200)).toBe(false);
		expect(tracker.turnCompleted(checkpoint, 1_360)).toBe(true);
	});

	test("does not replay lifecycle markers from overlap scans", () => {
		const tracker = new TerminalStateTracker();
		tracker.feed("esc to cancel", 1_000);
		tracker.feed("? for shortcuts", 1_400);
		const checkpoint = tracker.checkpoint();

		tracker.feed("terminal repaint without state markers", 2_000);
		expect(tracker.turnCompleted(checkpoint, 3_000)).toBe(false);
	});

	test("detects a workspace trust prompt", () => {
		const tracker = new TerminalStateTracker();
		const checkpoint = tracker.checkpoint();

		tracker.feed("Do you trust the contents of this project?", 1_000);
		expect(tracker.trustPromptedAfter(checkpoint)).toBe(true);
	});
});

describe("persistent agy settings", () => {
	afterEach(() => {
		delete process.env.AGY_PERSISTENT;
		delete process.env.AGY_PROMPT_TIMEOUT_MS;
	});

	test("is enabled by default and can be explicitly disabled", () => {
		expect(persistentAgyEnabled()).toBe(true);
		process.env.AGY_PERSISTENT = "0";
		expect(persistentAgyEnabled()).toBe(false);
	});

	test("uses a positive timeout override and ignores invalid values", () => {
		process.env.AGY_PROMPT_TIMEOUT_MS = "1234";
		expect(promptTimeoutMsFromEnv()).toBe(1234);

		process.env.AGY_PROMPT_TIMEOUT_MS = "invalid";
		expect(promptTimeoutMsFromEnv()).toBe(5 * 60 * 1000);
	});
});

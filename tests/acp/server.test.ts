import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as sdk from "@agentclientprotocol/sdk";
import { runAcp } from "../../src/acp/server";
import * as processUtils from "../../src/agy/process";
import * as ioUtils from "../../src/utils/process";

describe("runAcp", () => {
	afterEach(() => {
		mock.restore();
	});

	test("should map stdin/stdout helpers to ndJsonStream", async () => {
		let ndJsonStreamArgs: any[] = [];

		// Spy on SDK methods instead of mock.module
		spyOn(sdk, "ndJsonStream").mockImplementation(((...args: any[]) => {
			ndJsonStreamArgs = args;
			return "mocked_stream" as any;
		}) as any);

		const agentBuilder = {
			onRequest: () => agentBuilder,
			onNotification: () => agentBuilder,
			connect: (_stream: any) => {
				return { closed: Promise.resolve() };
			},
		};
		spyOn(sdk, "agent").mockReturnValue(agentBuilder as any);

		// Spy on discoverModels to prevent real background processes
		spyOn(processUtils, "discoverModels").mockResolvedValue([]);

		const mockWritable = new WritableStream();
		const mockReadable = new ReadableStream();
		const stdoutSpy = spyOn(ioUtils, "stdoutWritable").mockReturnValue(
			mockWritable as any,
		);
		const stdinSpy = spyOn(ioUtils, "stdinReadable").mockReturnValue(
			mockReadable as any,
		);

		runAcp();

		expect(stdinSpy).toHaveBeenCalled();
		expect(stdoutSpy).toHaveBeenCalled();

		expect(ndJsonStreamArgs.length).toBe(2);
		expect(ndJsonStreamArgs[0]).toBe(mockWritable);
		expect(ndJsonStreamArgs[1]).toBe(mockReadable);
	});
});

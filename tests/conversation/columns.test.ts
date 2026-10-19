import { describe, expect, test } from "bun:test";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import {
	decodeErrorDetails,
	decodeErrorMessageStep,
	decodeModelUsage,
	decodePermissions,
	decodeTaskDetails,
	decodeToolOutput,
} from "../../src/conversation/columns";
import { TaskDetails } from "../../src/gen/steps";

describe("conversation/columns", () => {
	describe("decodeErrorMessageStep", () => {
		test("extracts the error and its Error ID from step_payload", () => {
			const writer = new BinaryWriter();
			// 24: { 3: error_details { 2: detail, 6: id } }
			writer.tag(24, 2).fork();
			writer.tag(3, 2).fork();
			writer.tag(2, 2).string("Individual quota reached.");
			writer.tag(6, 2).string("error-id-1");
			writer.join();
			writer.join();

			const decoded = decodeErrorMessageStep(writer.finish());
			expect(decoded?.detail).toBe("Individual quota reached.");
			expect(decoded?.id).toBe("error-id-1");
		});

		test("returns null when the payload has no error message", () => {
			const writer = new BinaryWriter();
			writer.tag(1, 0).uint32(17);
			expect(decodeErrorMessageStep(writer.finish())).toBeNull();
		});
	});

	describe("decodeModelUsage", () => {
		test("decodes the usage buckets from field 5.9", () => {
			const writer = new BinaryWriter();
			// 5: { 4: tool call (unrelated), 9: { 2: input, 3: output, 5: cache read, 9: reasoning, 10: visible } }
			writer.tag(5, 2).fork();
			writer.tag(4, 2).fork();
			writer.tag(1, 2).string("call_171167");
			writer.join();
			writer.tag(9, 2).fork();
			writer.tag(2, 0).uint32(11751);
			writer.tag(3, 0).uint32(225);
			writer.tag(5, 0).uint32(16609);
			writer.tag(9, 0).uint32(165);
			writer.tag(10, 0).uint32(60);
			writer.join();
			writer.join();

			const decoded = decodeModelUsage(writer.finish());

			expect(decoded).toEqual({
				inputTokens: 11751,
				cacheReadTokens: 16609,
				reasoningTokens: 165,
				visibleOutputTokens: 60,
			});
		});

		test("treats absent buckets as zero", () => {
			const writer = new BinaryWriter();
			writer.tag(5, 2).fork();
			writer.tag(9, 2).fork();
			writer.tag(2, 0).uint32(1026);
			writer.tag(10, 0).uint32(353);
			writer.join();
			writer.join();

			const decoded = decodeModelUsage(writer.finish());

			expect(decoded).toEqual({
				inputTokens: 1026,
				cacheReadTokens: 0,
				reasoningTokens: 0,
				visibleOutputTokens: 353,
			});
		});

		test("returns null when the step reports no usage", () => {
			const writer = new BinaryWriter();
			writer.tag(1, 0).uint32(15);
			writer.tag(20, 2).fork();
			writer.tag(1, 2).string("hello");
			writer.join();

			expect(decodeModelUsage(writer.finish())).toBeNull();
			expect(decodeModelUsage(new Uint8Array(0))).toBeNull();
		});

		test("returns null when every bucket is zero", () => {
			const writer = new BinaryWriter();
			writer.tag(5, 2).fork();
			writer.tag(9, 2).fork();
			writer.tag(2, 0).uint32(0);
			writer.join();
			writer.join();

			expect(decodeModelUsage(writer.finish())).toBeNull();
		});
	});

	describe("decodeErrorDetails", () => {
		test("decodes full error details", () => {
			const writer = new BinaryWriter();
			// 1: message
			writer.tag(1, 2).string("Oops");
			// 2: detail
			writer.tag(2, 2).string("Something went wrong");
			// 3: stackTrace
			writer.tag(3, 2).string("Error at line 1");

			const bytes = writer.finish();
			const decoded = decodeErrorDetails(bytes);

			expect(decoded.message).toBe("Oops");
			expect(decoded.detail).toBe("Something went wrong");
			expect(decoded.stackTrace).toBe("Error at line 1");
		});

		test("drops unknown tags", () => {
			const writer = new BinaryWriter();
			writer.tag(1, 2).string("Valid message");
			writer.tag(99, 2).string("Unknown field");
			writer.tag(4, 0).uint32(42); // Unknown integer tag
			writer.tag(2, 2).string("Valid detail");

			const bytes = writer.finish();
			const decoded = decodeErrorDetails(bytes);

			expect(decoded.message).toBe("Valid message");
			expect(decoded.detail).toBe("Valid detail");
		});

		test("returns fallback strings when empty", () => {
			const decoded = decodeErrorDetails(new Uint8Array(0));
			expect(decoded.message).toBe("");
			expect(decoded.detail).toBe("");
			expect(decoded.stackTrace).toBe("");
		});
	});

	describe("decodePermissions", () => {
		test("decodes permission info", () => {
			const writer = new BinaryWriter();

			// Inner target message { 1: kind, 2: value }
			const targetWriter = new BinaryWriter();
			targetWriter.tag(1, 2).string("command");
			targetWriter.tag(2, 2).string("ls -la");
			const targetBytes = targetWriter.finish();

			// Inner entry message { 1: target, 2: decision }
			const entryWriter = new BinaryWriter();
			entryWriter.tag(1, 2).bytes(targetBytes);
			entryWriter.tag(2, 0).int64(1n); // decision = 1
			const entryBytes = entryWriter.finish();

			// Outer wrapper { 2: entry }
			writer.tag(2, 2).bytes(entryBytes);

			const bytes = writer.finish();
			const decoded = decodePermissions(bytes);

			expect(decoded).not.toBeNull();
			expect(decoded!.kind).toBe("command");
			expect(decoded!.value).toBe("ls -la");
			expect(decoded!.decision).toBe(1);
		});

		test("drops unknown tags and handles missing fields", () => {
			const writer = new BinaryWriter();
			writer.tag(1, 2).string("unknown outer tag");

			const entryWriter = new BinaryWriter();
			entryWriter.tag(3, 2).string("unknown entry tag");
			entryWriter.tag(2, 0).int64(2n); // decision
			const entryBytes = entryWriter.finish();

			writer.tag(2, 2).bytes(entryBytes);

			const bytes = writer.finish();
			const decoded = decodePermissions(bytes);

			expect(decoded).not.toBeNull();
			expect(decoded!.kind).toBe(""); // missing target
			expect(decoded!.value).toBe("");
			expect(decoded!.decision).toBe(2);
		});

		test("returns null when no permission entry is present", () => {
			const writer = new BinaryWriter();
			writer.tag(1, 2).string("other stuff");
			const decoded = decodePermissions(writer.finish());
			expect(decoded).toBeNull();
		});
	});

	describe("decodeTaskDetails", () => {
		test("decodes TaskDetails using generated message", () => {
			const encoded = TaskDetails.encode({
				taskId: "t123",
				logUri: "file://path/to/log",
				description: "Background task",
			}).finish();

			const decoded = decodeTaskDetails(encoded);
			expect(decoded.taskId).toBe("t123");
			expect(decoded.logUri).toBe("file://path/to/log");
			expect(decoded.description).toBe("Background task");
		});
	});

	describe("decodeToolOutput", () => {
		test("decodes nested tool output from field 140", () => {
			// Nested tag 2 message { 1: outputString }
			const outputWriter = new BinaryWriter();
			outputWriter.tag(1, 2).string("hello from tool output\nsuccess");
			const outputBytes = outputWriter.finish();

			// Field 140 message { 2: outputMessage }
			const f140Writer = new BinaryWriter();
			f140Writer.tag(2, 2).bytes(outputBytes);
			const f140Bytes = f140Writer.finish();

			// Step payload { 140: f140Message }
			const payloadWriter = new BinaryWriter();
			payloadWriter.tag(140, 2).bytes(f140Bytes);
			const payloadBytes = payloadWriter.finish();

			const output = decodeToolOutput(payloadBytes);
			expect(output).toBe("hello from tool output\nsuccess");
		});

		test("returns null when field 140 is absent", () => {
			const writer = new BinaryWriter();
			writer.tag(1, 0).uint32(132);
			expect(decodeToolOutput(writer.finish())).toBeNull();
		});

		test("returns null on empty input", () => {
			expect(decodeToolOutput(new Uint8Array(0))).toBeNull();
		});
	});
});

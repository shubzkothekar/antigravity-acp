import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../../types";
import {
	asStr,
	codeBlock,
	fsPath,
	parseRawInput,
	pick,
	toolCallUpdate,
} from "../utils";

/**
{
  "idx": 12,
  "stepType": 21,
  "parsedPayload": {
    "validityCheck": "21",
    "toolRun": {
      "call": {
        "callId": "a4u6fsq8",
        "namePrimary": "run_command",
        "rawInputJson": "{\"CommandLine\":\"echo \\\"Hello, World!\\\"\",\"Cwd\":\"/Users/user/Desktop\",\"WaitMsBeforeAsync\":5000,\"toolAction\":\"Running command\",\"toolSummary\":\"Run echo command\"}",
        "nameSecondary": "run_command"
      },
      "titlePrimary": "Run echo command",
      "titleSecondary": "Running command"
    }
  }
}
*/

/**
 * Build a tool_call update for a `run_command` step (type 21).
 *
 * The command lives JSON-encoded in `rawInputJson` — the previous version
 * called `pick` directly on that string, so the command was never extracted and
 * the title always fell back to a generic label. We parse first, surface the
 * command as the title, and echo it as a code block with the cwd as a location.
 */
export function executeUpdate(stepRow: StepRow, _cwd?: string): SessionUpdate {
	const { stepPayload } = stepRow;
	const toolRun = stepPayload.toolRun;

	const rawInput = parseRawInput(stepRow);

	const cmd = asStr(pick(rawInput, "CommandLine", "commandLine", "command"));
	const firstLine = (cmd?.split("\n")[0] ?? "").trim();

	const title =
		firstLine ||
		asStr(toolRun?.titlePrimary)?.trim() ||
		asStr(toolRun?.titleSecondary)?.trim() ||
		"Command Execution";

	const content: Record<string, unknown>[] = [];
	const output = stepRow.toolOutput;
	if (output && output.trim().length > 0) {
		content.push(codeBlock(output.trim()));
	} else if (cmd && cmd.trim().length > 0) {
		content.push(codeBlock(cmd));
	}

	// Locations use absolute paths (consistent with the other builders); the
	// command's working directory is the only path a run_command exposes.
	const locations: Record<string, unknown>[] = [];
	const commandCwd = fsPath(asStr(pick(rawInput, "Cwd", "cwd")));
	if (commandCwd) {
		locations.push({ path: commandCwd });
	}

	return toolCallUpdate({
		stepRow,
		title,
		kind: "execute",
		content,
		locations,
		rawOutput: output != null ? { output } : undefined,
	});
}

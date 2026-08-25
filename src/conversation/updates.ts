import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../types";
import { agentUpdate } from "../updates/agent";
import { LIFECYCLE_STEP_TYPES, lifecycleUpdate } from "../updates/lifecycle";
import { titleUpdate } from "../updates/title";
import { editUpdate } from "../updates/tools/edit";
import { executeUpdate } from "../updates/tools/execute";
import { fetchUpdate } from "../updates/tools/fetch";
import { otherUpdate } from "../updates/tools/other";
import { questionUpdate } from "../updates/tools/question";
import { readUpdate } from "../updates/tools/read";
import { searchUpdate } from "../updates/tools/search";
import { subagentUpdate } from "../updates/tools/subagent";
import { userPromptUpdate } from "../updates/userPrompt";

/**
 * Route a tool step to the right builder by its tool name rather than its step
 * type. Used for step type 17 (which mixes view_file / run_command / edits /
 * artifact wrappers under one type) and as the fallback for unknown step types.
 *
 * Returns `null` when the step carries no actual tool call (e.g. type-17
 * artifact progress wrappers have a tool-run header but no `call`), so we don't
 * emit empty tool_calls.
 */
function buildByToolName(
	stepRow: StepRow,
	cwd?: string,
): SessionUpdate | SessionUpdate[] | null {
	const name = stepRow.stepPayload.toolRun?.call?.namePrimary ?? "";
	if (!name) return null;

	if (name === "view_file" || name === "list_dir")
		return readUpdate(stepRow, cwd);
	if (
		name === "grep_search" ||
		name === "search_web" ||
		name === "find_by_name"
	)
		return searchUpdate(stepRow, cwd);
	if (name === "run_command") return executeUpdate(stepRow, cwd);
	if (name === "read_url_content") return fetchUpdate(stepRow);
	if (name === "invoke_subagent") return subagentUpdate(stepRow);
	if (name === "ask_question") return questionUpdate(stepRow);
	if (
		name.includes("write") ||
		name.includes("replace") ||
		name.includes("edit") ||
		name.includes("patch")
	)
		return editUpdate(stepRow, cwd);

	return otherUpdate(stepRow);
}

/**
 * Translate a single agy conversation step into an ACP session update.
 *
 * Each step type is routed to a dedicated builder (see `src/updates/`). Returns
 * `null` when a step has no user-facing representation (lifecycle/system steps)
 * or when a tool step carries no tool run to render.
 *
 * Step-type map:
 *   14            user prompt            → user_message_chunk
 *   15            agent text chunk       → agent_message_chunk
 *   23            title update           → session_info_update
 *   5             file edit              → tool_call (edit)
 *   17            mixed artifact tools   → routed by tool name (or skipped)
 *   8, 9          view_file / list_dir   → tool_call (read)
 *   7, 33         grep / web search      → tool_call (search)
 *   21            run_command            → tool_call (execute)
 *   31            read_url_content       → tool_call (fetch)
 *   127           invoke_subagent        → tool_call (other)
 *   138           ask_question           → tool_call (other)
 *   132           modern tool calls      → routed by tool name
 *   90, 98, 101   lifecycle/system       → null (skipped)
 *   default       unknown tool step      → tool_call (generic) or null
 */
export const buildUpdatefromStepPayload = (
	stepRow: StepRow,
	cwd?: string,
): SessionUpdate | SessionUpdate[] | null => {
	const { stepType } = stepRow;

	switch (stepType) {
		case 14:
			return userPromptUpdate(stepRow);

		case 15:
			return agentUpdate(stepRow);

		case 23:
			return titleUpdate(stepRow);

		case 5: // write_to_file / replace_file_content / multi_replace_file_content
			return editUpdate(stepRow, cwd);

		case 17:
			// Mixed bag: view_file / run_command / edits, plus artifact wrappers with
			// no call. Route by tool name; skip the empty wrappers.
			return buildByToolName(stepRow, cwd);

		case 8: // view_file
		case 9: // list_dir
			return readUpdate(stepRow, cwd);

		case 7: // grep_search
		case 33: // search_web
			return searchUpdate(stepRow, cwd);

		case 21: // run_command
			return executeUpdate(stepRow, cwd);

		case 31: // read_url_content
			return fetchUpdate(stepRow);

		case 127: // invoke_subagent
			return subagentUpdate(stepRow);

		case 138: // ask_question
			return questionUpdate(stepRow);

		case 132: // Modern agy tool step: run_command, view_file, grep_search, etc.
			return buildByToolName(stepRow, cwd);

		case 90: // ephemeral_message
		case 98: // conversation_history
		case 101: // stop_hook / auto_proceed
			return lifecycleUpdate(stepRow);

		default:
			// Unknown step types: route real tool calls by name; skip lifecycle
			// markers and header-only steps that carry no renderable call.
			if (LIFECYCLE_STEP_TYPES.has(stepType)) return null;
			return buildByToolName(stepRow, cwd);
	}
};

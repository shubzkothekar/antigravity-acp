import type {
	ErrorDetails,
	PermissionInfo,
	TaskDetails,
} from "../conversation/columns";
import type { StepPayload } from "../gen/steps";

/** A row from the steps table. */
export type StepRow = {
	idx: number;
	stepType: number;
	/**
	 * agy step status enum (from the `status` column):
	 *   2 = in progress, 3 = completed, 6 = cancelled/aborted, 7 = failed.
	 * Mapped to ACP tool_call status by `toolCallStatus` in updates/utils.
	 */
	status: number;
	stepPayload: StepPayload;
	/** Decoded tool execution output (from field 140 of `step_payload`). */
	toolOutput?: string | null;
	/** Decoded `error_details` column, when the step carries an error. */
	error?: ErrorDetails | null;
	/** Decoded `permissions` column, when the step requested a permission. */
	permission?: PermissionInfo | null;
	/** Decoded `task_details` column, for background-task steps. */
	task?: TaskDetails | null;
};

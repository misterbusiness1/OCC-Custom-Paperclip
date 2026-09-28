import { conflict } from "../errors.js";

const NON_INVOCABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

export function assertIssueAssigneeExecutableState(input: {
  status: string;
  assigneeAgentId: string | null;
  assigneeStatus: string | null;
  hasUnresolvedBlocker?: boolean;
}) {
  if (!input.assigneeAgentId || !input.assigneeStatus || !NON_INVOCABLE_AGENT_STATUSES.has(input.assigneeStatus)) {
    return;
  }
  if (
    input.assigneeStatus === "paused"
    && input.status === "blocked"
    && input.hasUnresolvedBlocker === true
  ) return;
  throw conflict(`Cannot assign ${input.status} work to ${input.assigneeStatus} agents`);
}

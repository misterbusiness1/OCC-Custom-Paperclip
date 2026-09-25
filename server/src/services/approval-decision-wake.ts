import { and, eq } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

// Fork (PR #104, OXFA-31274): board decisions on an approval (approve /
// reject / request revision) are addressed to the agent that requested it.
// Agents park the linked issue with a human owner while the approval is
// pending, so the queued-run assignee guard must not treat the decision wake
// as a stale reassignment and cancel it. The dependency and terminal-status
// gates additionally require the approval to be verified against
// approvals.requested_by_agent_id (see isVerifiedApprovalDecisionWakeForRequester).
//
// Shared by heartbeat.ts (queued-run claim and wake admission gates) and the
// run-dispatch / wake-queue module adapters, so every gate reads one
// definition.
export const APPROVAL_DECISION_WAKE_REASONS: ReadonlySet<string> = new Set([
  "approval_approved",
  "approval_rejected",
  "approval_revision_requested",
]);

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Unverified shape check: the wake is a board decision that names its
 * approval. Only the queued-run assignee guard trusts this alone.
 */
export function isApprovalDecisionWakeForRequester(
  contextSnapshot: Record<string, unknown> | null | undefined,
): boolean {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !APPROVAL_DECISION_WAKE_REASONS.has(wakeReason)) return false;
  return readNonEmptyString(contextSnapshot?.approvalId) !== null;
}

/**
 * Unlike the assignee guard, the dependency and terminal-status gates only let
 * a decision wake through when the approval really was requested by the woken
 * agent, so review-path wakes to other owners keep the normal gating.
 */
export async function isVerifiedApprovalDecisionWakeForRequester(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId: string;
    contextSnapshot: Record<string, unknown> | null | undefined;
  },
): Promise<boolean> {
  if (!isApprovalDecisionWakeForRequester(input.contextSnapshot)) return false;
  const approvalId = readNonEmptyString(input.contextSnapshot?.approvalId);
  if (!approvalId || !isUuidLike(approvalId)) return false;
  const approval = await dbOrTx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(
      eq(approvals.id, approvalId),
      eq(approvals.companyId, input.companyId),
      eq(approvals.requestedByAgentId, input.agentId),
    ))
    .then((rows) => rows[0] ?? null);
  return approval !== null;
}

/** Run success is deliberately not an input: only persisted domain state resolves a revision. */
export const REVISION_RECOVERY_MAX_ATTEMPTS = 3;
export const REVISION_RECOVERY_TIMEOUT_MS = 24 * 60 * 60_000;
export const REVISION_OUTCOME_ACTIVITY = "approval.revision_outcome";
export const REVISION_ATTEMPT_ACTIVITY = "approval.revision_recovery_attempt";

export function revisionIdentity(approvalId: string, decidedAt: Date) {
  return `${approvalId}:${decidedAt.toISOString()}`;
}

export type RevisionOutcome = "resubmitted" | "disposed" | "durable_blocker" | "unresolved";
export function decideRevisionRecovery(input: {
  status: string;
  decidedAt: Date;
  now: Date;
  attemptCount: number;
  lastAttemptAt: Date | null;
  blocker: string | null;
  activeExecution: boolean;
  invokable: boolean;
}): { outcome: RevisionOutcome; action: "none" | "retry" | "escalate";
  blocker: string | null; nextFollowUpAt: string | null } {
  const result = (outcome: RevisionOutcome, action: "none" | "retry" | "escalate", blocker: string | null = null,
    nextFollowUpAt: string | null = null) => ({ outcome, action, blocker, nextFollowUpAt });
  if (input.status === "pending") return result("resubmitted", "none");
  if (["approved", "rejected", "cancelled"].includes(input.status)) return result("disposed", "none");
  if (input.status !== "revision_requested") return result("unresolved", "none");
  if (input.blocker) return result("durable_blocker", "none", input.blocker);
  if (input.activeExecution) return result("unresolved", "none");
  if (!input.invokable) return result("unresolved", "escalate");
  if (input.attemptCount >= REVISION_RECOVERY_MAX_ATTEMPTS ||
    input.now.getTime() - input.decidedAt.getTime() >= REVISION_RECOVERY_TIMEOUT_MS) {
    return result("unresolved", "escalate");
  }
  const due = input.lastAttemptAt
    ? input.lastAttemptAt.getTime() + 15 * 60_000 * 2 ** Math.max(0, input.attemptCount - 1)
    : input.decidedAt.getTime() + 15 * 60_000;
  if (input.now.getTime() < due) return result("unresolved", "none", null, new Date(due).toISOString());
  return result("unresolved", "retry", null, new Date(input.now.getTime() + 15 * 60_000 * 2 ** input.attemptCount).toISOString());
}

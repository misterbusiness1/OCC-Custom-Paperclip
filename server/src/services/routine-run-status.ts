import { and, eq } from "drizzle-orm";
import { issues, routineRuns, type Db } from "@paperclipai/db";

const FAILURE_CODE = "execution_issue_status";
const FAILURE_STATUSES = ["blocked", "cancelled"] as const;
type FailureStatus = (typeof FAILURE_STATUSES)[number];

function failureReason(status: FailureStatus) {
  return `Execution issue moved to ${status}`;
}

function recordedFailure(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).transientFailure;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Project the originating execution only; linked skipped/coalesced runs are history. */
export async function syncRoutineRunStatusForIssue(db: Db, issueId: string, companyId?: string) {
  return db.transaction(async (tx) => {
    const issue = await tx.select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      originKind: issues.originKind,
      originRunId: issues.originRunId,
    }).from(issues).where(and(
      eq(issues.id, issueId),
      companyId ? eq(issues.companyId, companyId) : undefined,
    )).for("update").then((rows) => rows[0] ?? null);
    if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;

    const run = await tx.select().from(routineRuns).where(and(
      eq(routineRuns.id, issue.originRunId),
      eq(routineRuns.companyId, issue.companyId),
    )).for("update").then((rows) => rows[0] ?? null);
    if (!run) return null;

    const prior = recordedFailure(run.triggerPayload);
    const priorStatus = (prior?.code === FAILURE_CODE
      ? FAILURE_STATUSES.find((status) => status === prior.status)
      : null) ?? FAILURE_STATUSES.find((status) => run.failureReason === failureReason(status));
    const clearedAt = typeof prior?.clearedAt === "string" ? prior.clearedAt : null;
    const now = new Date();
    let patch: Partial<typeof routineRuns.$inferInsert>;
    if (issue.status === "done") {
      if (run.status === "completed" && run.failureReason === null && run.completedAt) return run;
      patch = {
        status: "completed",
        failureReason: null,
        completedAt: now,
        ...(priorStatus ? { triggerPayload: {
          ...(run.triggerPayload ?? {}),
          transientFailure: {
            code: FAILURE_CODE,
            status: priorStatus,
            reason: failureReason(priorStatus),
            clearedAt: clearedAt ?? now.toISOString(),
          },
        } } : {}),
      };
    } else if (issue.status === "blocked" || issue.status === "cancelled") {
      const reason = failureReason(issue.status);
      if (run.status === "failed" && run.failureReason === reason &&
          prior?.code === FAILURE_CODE && prior.status === issue.status &&
          !clearedAt && run.completedAt) return run;
      patch = {
        status: "failed",
        failureReason: reason,
        completedAt: now,
        triggerPayload: {
          ...(run.triggerPayload ?? {}),
          transientFailure: {
            code: FAILURE_CODE,
            status: issue.status,
            reason,
            recordedAt: now.toISOString(),
          },
        },
      };
    } else if (run.status === "failed" && priorStatus) {
      patch = {
        status: "issue_created",
        failureReason: null,
        completedAt: null,
        triggerPayload: {
          ...(run.triggerPayload ?? {}),
          transientFailure: {
            code: FAILURE_CODE,
            status: priorStatus,
            reason: failureReason(priorStatus),
            clearedAt: now.toISOString(),
          },
        },
      };
    } else {
      return null;
    }
    return tx.update(routineRuns).set({ ...patch, updatedAt: now }).where(and(
      eq(routineRuns.id, run.id),
      eq(routineRuns.companyId, issue.companyId),
    )).returning().then((rows) => rows[0] ?? null);
  });
}

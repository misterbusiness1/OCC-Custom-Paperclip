import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  environmentLeases,
  executionWorkspaceRuntimeLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  workspaceOperations,
} from "@paperclipai/db";
import { emitAgentTaskRun } from "./agent-task-run-telemetry.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

export const TERMINAL_WAKE_QUEUED_RUN_CODE = "queued_run_terminal_wake_without_execution";
export const TERMINAL_WAKE_EXECUTION_OWNERSHIP_UNVERIFIED_CODE = "queued_wakeup_execution_ownership_unverified";

type Reconciliation =
  | { kind: "not_terminal_wake" }
  | { kind: "held_for_operator" }
  | { kind: "terminalized"; run: typeof heartbeatRuns.$inferSelect; event: typeof heartbeatRunEvents.$inferSelect };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminalWakeStatuses = ["cancelled", "failed", "skipped"];

function issueIdFrom(value: unknown): string | null | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const issueId = (value as Record<string, unknown>).issueId;
  if (issueId === undefined || issueId === null) return null;
  return typeof issueId === "string" && UUID.test(issueId) ? issueId : undefined;
}

/**
 * A terminal wake has withdrawn the authority for its still-queued run. Only
 * clean, never-started non-Board runs can be closed automatically. The wake,
 * issue and comments remain untouched. Ambiguous ownership remains queued for
 * an operator; it must never be treated as permission to dispatch a provider.
 *
 * Lock order matches the wake/claim paths: existing issue, wake, then run.
 */
export async function reconcileTerminalWakeQueuedRun(
  db: Db,
  candidate: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "wakeupRequestId" | "contextSnapshot">,
): Promise<Reconciliation> {
  if (!candidate.wakeupRequestId) return { kind: "not_terminal_wake" };
  const contextIssueId = issueIdFrom(candidate.contextSnapshot);
  if (contextIssueId === undefined) return { kind: "held_for_operator" };

  const reconciliation = await db.transaction(async (tx): Promise<Reconciliation> => {
    const issue = contextIssueId
      ? await tx.select().from(issues).where(and(
          eq(issues.companyId, candidate.companyId), eq(issues.id, contextIssueId),
        )).for("update").limit(1).then(rows => rows[0] ?? null)
      : null;
    const wake = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, candidate.wakeupRequestId!),
      eq(agentWakeupRequests.companyId, candidate.companyId),
      eq(agentWakeupRequests.agentId, candidate.agentId),
    )).for("update").limit(1).then(rows => rows[0] ?? null);
    const run = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, candidate.id),
      eq(heartbeatRuns.companyId, candidate.companyId),
      eq(heartbeatRuns.agentId, candidate.agentId),
    )).for("update").limit(1).then(rows => rows[0] ?? null);
    if (!run || run.status !== "queued") return { kind: "not_terminal_wake" };
    if (!wake || !terminalWakeStatuses.includes(wake.status)) {
      return wake ? { kind: "not_terminal_wake" } : { kind: "held_for_operator" };
    }
    // Board interrupts have a separate receipt and comment-authority path.
    if (
      wake.idempotencyKey?.startsWith("queued-comment-interrupt:") ||
      Boolean(wake.payload?.queuedCommentInterrupt)
    ) return { kind: "not_terminal_wake" };
    if (
      run.wakeupRequestId !== wake.id || wake.runId !== run.id ||
      run.companyId !== wake.companyId || run.agentId !== wake.agentId ||
      issueIdFrom(run.contextSnapshot) !== contextIssueId ||
      issueIdFrom(wake.payload) !== contextIssueId
    ) return { kind: "held_for_operator" };
    if (run.errorCode === TERMINAL_WAKE_EXECUTION_OWNERSHIP_UNVERIFIED_CODE) {
      return { kind: "held_for_operator" };
    }

    // A queued row may contain a previous session to resume, but no session
    // created by this run, controller, output or execution receipt may exist.
    const hasRecordedExecution = Boolean(
      run.startedAt || run.finishedAt || run.controllerBootId ||
      run.controllerLeaseExpiresAt || run.processPid || run.processGroupId ||
      run.processStartedAt || run.runnerInstanceId || run.nativeSessionId ||
      run.sessionIdAfter || run.externalRunId || run.executionStage ||
      run.nativePhase || run.nativePhaseUpdatedAt || run.activeIdentityContextId ||
      run.executionControlDeadlineAt || run.executionStatusDeliveryId ||
      run.lastOutputAt || run.lastOutputSeq > 0 || run.lastOutputStream ||
      run.lastOutputBytes !== null ||
      run.exitCode !== null || run.signal !== null || run.usageJson && Object.keys(run.usageJson).length > 0 ||
      run.resultJson && Object.keys(run.resultJson).length > 0 ||
      run.logStore || run.logRef || run.logBytes !== null || run.logSha256 ||
      run.logCompressed ||
      run.stdoutExcerpt || run.stderrExcerpt || run.driverKind || run.driverVersion ||
      run.completionContractId || run.completionContractSha256 || run.nativeIssueId ||
      run.issueCommentStatus !== "not_applicable" || run.issueCommentSatisfiedByCommentId ||
      run.issueCommentRetryQueuedAt || run.lastUsefulActionAt || run.livenessState ||
      run.livenessReason || run.nextAction ||
      run.runnerProfileJson?.adapterDispatch
    );

    const first = async <T extends { id: unknown }>(query: PromiseLike<T[]>): Promise<boolean> =>
      (await query).length > 0;
    const hasRelatedExecution = hasRecordedExecution ||
      await first(tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id))).limit(1)) ||
      await first(tx.select({ id: agentTaskSessions.id }).from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, run.companyId), eq(agentTaskSessions.lastRunId, run.id))).limit(1)) ||
      await first(tx.select({ id: environmentLeases.id }).from(environmentLeases)
        .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id))).limit(1)) ||
      await first(tx.select({ id: executionWorkspaceRuntimeLeases.id }).from(executionWorkspaceRuntimeLeases)
        .where(and(eq(executionWorkspaceRuntimeLeases.companyId, run.companyId), or(
          eq(executionWorkspaceRuntimeLeases.ownerRunId, run.id),
          eq(executionWorkspaceRuntimeLeases.ownerKey, `run:${run.id}`),
          issue ? eq(executionWorkspaceRuntimeLeases.ownerIssueId, issue.id) : undefined,
        ))).limit(1)) ||
      await first(tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
        .where(and(eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id))).limit(1)) ||
      await first(tx.select({ id: workspaceOperations.id }).from(workspaceOperations)
        .where(and(eq(workspaceOperations.companyId, run.companyId), eq(workspaceOperations.heartbeatRunId, run.id))).limit(1));
    if (hasRelatedExecution) {
      const now = new Date();
      const [marked] = await tx.update(heartbeatRuns).set({
        error: "Queued run retains execution evidence; operator reconciliation required",
        errorCode: TERMINAL_WAKE_EXECUTION_OWNERSHIP_UNVERIFIED_CODE,
        updatedAt: now,
      }).where(and(
        eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "queued"),
        eq(heartbeatRuns.wakeupRequestId, wake.id), isNull(heartbeatRuns.errorCode),
      )).returning({ id: heartbeatRuns.id });
      if (marked) await tx.insert(activityLog).values({
        companyId: run.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "heartbeat.terminal_wake_queued_run_execution_ownership_unverified",
        entityType: "heartbeat_run",
        entityId: run.id,
        agentId: run.agentId,
        runId: run.id,
        responsibleUserId: run.responsibleUserId,
        details: { code: TERMINAL_WAKE_EXECUTION_OWNERSHIP_UNVERIFIED_CODE,
          wakeupRequestId: wake.id, issueId: contextIssueId },
      });
      return { kind: "held_for_operator" };
    }
    const conflictingIssueOwnership = await first(tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, run.companyId),
      or(eq(issues.executionRunId, run.id), eq(issues.checkoutRunId, run.id)),
      issue ? ne(issues.id, issue.id) : undefined,
    )).limit(1));
    if (
      issue?.checkoutRunId === run.id || conflictingIssueOwnership ||
      await first(tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, run.companyId),
        eq(agentWakeupRequests.agentId, run.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        or(
          eq(agentWakeupRequests.runId, run.id),
          contextIssueId ? sql`${agentWakeupRequests.payload}->>'issueId' = ${contextIssueId}` : undefined,
        ),
      )).limit(1))
    ) return { kind: "held_for_operator" };

    const now = new Date();
    const error = `Queued run closed because its bound wake was ${wake.status} before execution`;
    const [closed] = await tx.update(heartbeatRuns).set({
      status: "cancelled",
      errorCode: TERMINAL_WAKE_QUEUED_RUN_CODE,
      error,
      finishedAt: now,
      executionStatusDeliveryId: randomUUID(),
      resultJson: {
        ...(run.resultJson ?? {}),
        terminalWakeReconciliation: {
          code: TERMINAL_WAKE_QUEUED_RUN_CODE,
          wakeupRequestId: wake.id,
          wakeStatus: wake.status,
          providerDispatched: false,
        },
      },
      updatedAt: now,
    }).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "queued"),
      eq(heartbeatRuns.wakeupRequestId, wake.id),
    )).returning();
    if (!closed) return { kind: "held_for_operator" };
    // This run may have claimed its issue before the provider ever started.
    // Once the terminal wake and absence of execution evidence are proven,
    // clear only this run's matching execution lock. Checkout ownership remains
    // a hold above because it may represent an independent workspace operation.
    if (issue?.executionRunId === run.id) {
      await tx.update(issues).set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      }).where(and(
        eq(issues.id, issue.id),
        eq(issues.companyId, run.companyId),
        eq(issues.executionRunId, run.id),
      ));
    }
    await tx.insert(activityLog).values({
      companyId: run.companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "heartbeat.terminal_wake_queued_run_reconciled",
      entityType: "heartbeat_run",
      entityId: run.id,
      agentId: run.agentId,
      runId: run.id,
      responsibleUserId: run.responsibleUserId,
      details: {
        code: TERMINAL_WAKE_QUEUED_RUN_CODE,
        wakeupRequestId: wake.id,
        wakeStatus: wake.status,
        issueId: contextIssueId,
        issuePresent: Boolean(issue),
        providerDispatched: false,
      },
    });
    // Persist the run log with the status transition. A process restart after
    // commit must not erase the only inspectable record of this cancellation.
    const lifecycleEvent = await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: error,
      payload: {
        code: TERMINAL_WAKE_QUEUED_RUN_CODE,
        wakeupRequestId: wake.id,
        wakeStatus: wake.status,
        providerDispatched: false,
      },
    });
    return { kind: "terminalized", run: closed, event: lifecycleEvent.row };
  });
  // Telemetry can query committed state, so emit it only after the transaction
  // succeeds. It is best-effort and must not delay queued-work recovery.
  if (reconciliation.kind === "terminalized") {
    void emitAgentTaskRun(db, reconciliation.run);
  }
  return reconciliation;
}

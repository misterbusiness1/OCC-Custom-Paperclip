import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Return an undispatched local claim to queue in the queue editor's lock order. */
export async function releaseRunClaimedJustBeforeSuppression(db: Db, runId: string, controllerBootId: string) {
  const now = new Date();
  // Read only a lock-order hint, then revalidate the complete identity after
  // issue -> wake -> run locks. Never take the run first against queue editors.
  const [hint] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (!hint || hint.status !== "running") return;
  const hintedIssueId = readNonEmptyString(parseObject(hint.contextSnapshot).issueId);
  await db.transaction(async (tx) => {
    if (hintedIssueId) await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, hintedIssueId), eq(issues.companyId, hint.companyId))).for("update");
    const [lockedWake] = hint.wakeupRequestId
      ? await tx.select({
          id: agentWakeupRequests.id,
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          runId: agentWakeupRequests.runId,
          status: agentWakeupRequests.status,
        }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.id, hint.wakeupRequestId),
            eq(agentWakeupRequests.companyId, hint.companyId))).for("update")
      : [];
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    if (!current || current.status !== "running" || current.companyId !== hint.companyId
        || current.agentId !== hint.agentId || current.wakeupRequestId !== hint.wakeupRequestId
        || readNonEmptyString(parseObject(current.contextSnapshot).issueId) !== hintedIssueId) return;
    // Suppression may return an undispatched claim to queue, but it must not
    // revive a wake that another actor cancelled while the run was preparing.
    if (current.wakeupRequestId && (!lockedWake || lockedWake.status !== "claimed"
        || lockedWake.runId !== current.id || lockedWake.agentId !== current.agentId)) return;
    if (current.runtimeMode === "legacy" && (current.controllerBootId !== controllerBootId
        || current.executionStage !== "preparing" || current.processPid !== null)) return;
    const released = await tx
      .update(heartbeatRuns)
      .set({
        status: "queued",
        startedAt: null,
        responsibleUserId: null,
        ...(current.runtimeMode === "legacy" ? {
          controllerBootId: null,
          controllerLeaseExpiresAt: null,
          executionStage: null,
        } : {}),
        updatedAt: now,
      })
      .where(
        and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!released) return;

    if (released.wakeupRequestId) {
      const [releasedWake] = await tx
        .update(agentWakeupRequests)
        .set({ status: "queued", claimedAt: null, updatedAt: now })
        .where(and(eq(agentWakeupRequests.id, released.wakeupRequestId),
          eq(agentWakeupRequests.companyId, released.companyId),
          eq(agentWakeupRequests.agentId, released.agentId),
          eq(agentWakeupRequests.runId, released.id),
          eq(agentWakeupRequests.status, "claimed")))
        .returning({ id: agentWakeupRequests.id });
      if (!releasedWake) throw new Error("queued claim release lost claimed wake authority");
    }

    const context = parseObject(released.contextSnapshot);
    const issueId = readNonEmptyString(context.issueId);
    if (issueId) {
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.companyId, released.companyId),
            eq(issues.executionRunId, released.id),
          ),
        );
    }
  });
}

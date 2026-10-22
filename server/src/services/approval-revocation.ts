import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, approvals, heartbeatRuns, toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { nextApprovalUpdatedAt } from "./approval-version.js";

/** Withdraw future authority; never claim to reverse an external action. */
export async function revokeApproval(db: Db, input: {
  companyId: string; approvalId: string; userId: string; decisionNote: string; expectedUpdatedAt: Date;
}) {
  if (!input.decisionNote.trim() || !Number.isFinite(input.expectedUpdatedAt.getTime())) {
    throw unprocessable("Revocation requires a reason and the exact approval version");
  }
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async tx => {
    const [current] = await tx.select().from(approvals).where(and(
      eq(approvals.id, input.approvalId), eq(approvals.companyId, input.companyId))).for("update");
    if (!current) throw notFound("Approval not found");
    if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw conflict("This approval changed. Reload it before revoking.", { code: "approval_version_conflict" });
    }
    if (current.status !== "approved" || current.type !== "request_board_approval") {
      throw unprocessable("Only an approved board request can be revoked; hire and budget side effects cannot be reversed here");
    }
    // Discover immutable bindings, then match native settlement's invocation ->
    // request lock order. Re-read the requests under lock before using them.
    const candidates = await tx.select({ id: toolActionRequests.id, invocationId: toolActionRequests.invocationId })
      .from(toolActionRequests).where(and(eq(toolActionRequests.companyId, input.companyId),
        eq(toolActionRequests.approvalId, current.id))).orderBy(asc(toolActionRequests.id));
    const invocationIds = [...new Set(candidates.map(x => x.invocationId))];
    const invocations = invocationIds.length ? await tx.select().from(toolInvocations).where(and(
      eq(toolInvocations.companyId, input.companyId), inArray(toolInvocations.id, invocationIds)))
      .orderBy(asc(toolInvocations.id)).for("update") : [];
    const actions = await tx.select().from(toolActionRequests).where(and(
      eq(toolActionRequests.companyId, input.companyId), eq(toolActionRequests.approvalId, current.id)))
      .orderBy(asc(toolActionRequests.id)).for("update");
    if (actions.length !== candidates.length || actions.some((action, index) =>
      action.id !== candidates[index]?.id || action.invocationId !== candidates[index]?.invocationId)) {
      throw conflict("Approval actions changed. Reload before revoking.", { code: "approval_actions_changed" });
    }
    if (invocations.length !== invocationIds.length) {
      throw conflict("Tool action has an invalid company binding; reconcile it before revocation", { code: "approval_action_scope_invalid" });
    }
    // Read terminal history too: completion cannot erase execution evidence.
    // Match heartbeat admission's wake -> run lock order. Reversing it can
    // deadlock a dispatcher that already owns the wake and is claiming its run.
    const wakes = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      sql`${agentWakeupRequests.payload}->>'approvalId' = ${current.id}`))
      .orderBy(asc(agentWakeupRequests.id)).for("update");
    const runs = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'approvalId' = ${current.id}`))
      .orderBy(asc(heartbeatRuns.id)).for("update");
    const payload = current.payload;
    if (actions.some(x => ["executing", "executed"].includes(x.status))
      || invocations.some(x => x.startedAt !== null || ["executing", "succeeded"].includes(x.status))
      || wakes.some(x => !["queued", "deferred_issue_execution", "deferred_agent_execution"].includes(x.status) || x.claimedAt !== null)
      || runs.some(x => !["queued", "scheduled_retry"].includes(x.status) || x.startedAt !== null)
      || Boolean(payload.sentAt || payload.executedAt)
      || [payload.sendStatus, payload.executionStatus].some(status =>
        ["sent", "executed", "succeeded", "completed"].includes(String(status ?? "")))) {
      throw conflict("Execution has started or completed. Reconcile its outcome before withdrawing authority; revocation cannot undo it.",
        { code: "approval_execution_started" });
    }
    const now = new Date();
    const cancelledActions = await tx.update(toolActionRequests).set({ status: "cancelled", resolvedAt: now, updatedAt: now })
      .where(and(eq(toolActionRequests.companyId, input.companyId), eq(toolActionRequests.approvalId, current.id),
        inArray(toolActionRequests.status, ["pending", "approved"]))).returning({ id: toolActionRequests.id });
    if (invocationIds.length) await tx.update(toolInvocations).set({ status: "cancelled", completedAt: now, updatedAt: now,
      errorCode: "approval_revoked", errorMessage: "Board approval was revoked before execution" }).where(and(
        eq(toolInvocations.companyId, input.companyId), inArray(toolInvocations.id, invocationIds),
        isNull(toolInvocations.startedAt), inArray(toolInvocations.status, ["pending", "authorized", "awaiting_approval"])));
    const cancelledRuns = await tx.update(heartbeatRuns).set({ status: "cancelled", finishedAt: now, updatedAt: now,
      errorCode: "approval_revoked", error: "Board approval was revoked before execution" }).where(and(
        eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.contextSnapshot}->>'approvalId' = ${current.id}`,
        isNull(heartbeatRuns.startedAt), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]))).returning({ id: heartbeatRuns.id });
    const cancelledWakes = await tx.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: now, updatedAt: now,
      error: "Board approval revoked" }).where(and(eq(agentWakeupRequests.companyId, input.companyId),
        sql`${agentWakeupRequests.payload}->>'approvalId' = ${current.id}`,
        isNull(agentWakeupRequests.claimedAt), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "deferred_agent_execution"])))
      .returning({ id: agentWakeupRequests.id });
    const [approval] = await tx.update(approvals).set({ status: "cancelled", decidedByUserId: input.userId,
      decisionNote: input.decisionNote.trim(), decidedAt: now, updatedAt: nextApprovalUpdatedAt(now) })
      .where(and(eq(approvals.id, current.id), eq(approvals.companyId, input.companyId))).returning();
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.userId,
      action: "approval.revoked", entityType: "approval", entityId: current.id,
      details: { previousStatus: current.status, previousDecidedAt: current.decidedAt?.toISOString() ?? null,
        previousDecidedByUserId: current.decidedByUserId, approvalUpdatedAt: approval!.updatedAt.toISOString(),
        cancelledActionIds: cancelledActions.map(x => x.id), cancelledRunIds: cancelledRuns.map(x => x.id),
        cancelledWakeIds: cancelledWakes.map(x => x.id), executionSuppressed: true } }, publications);
    return approval!;
  });
  // This event is informational, never approval.approved or an execution hook.
  for (const publication of publications) publishActivity(publication);
  return result;
}

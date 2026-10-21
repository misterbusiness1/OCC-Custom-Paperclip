import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, approvals, issueApprovals, issues } from "@paperclipai/db";
import { isUuidLike, type ApprovalQueueAttention } from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

type QueueRow = typeof approvals.$inferSelect;

/** Batch-only, company-scoped diagnostics. No automatic close, wake or approval decision. */
export async function approvalQueueAttention(db: Db, companyId: string, rows: QueueRow[]) {
  const open = rows.filter((row) => row.status === "pending" || row.status === "revision_requested");
  const result = new Map<string, ApprovalQueueAttention>();
  if (!open.length) return result;
  const ids = open.map((row) => row.id);
  const agentIds = open.flatMap((row) => row.requestedByAgentId ? [row.requestedByAgentId] : []);
  const replacementIds = open.flatMap((row) => {
    const id = row.payload.supersededByApprovalId;
    return typeof id === "string" && isUuidLike(id) && id !== row.id ? [id] : [];
  });
  const [decisions, links, requesters, replacements, outcomes] = await Promise.all([
    db.select({ approvalId: activityLog.entityId, createdAt: activityLog.createdAt })
      .from(activityLog).where(and(eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "approval"), eq(activityLog.action, "approval.revision_requested"),
        inArray(activityLog.entityId, ids))).orderBy(desc(activityLog.createdAt)),
    db.select({ approvalId: issueApprovals.approvalId, id: issues.id, identifier: issues.identifier,
      status: issues.status, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
      unblockDescriptor: issues.unblockDescriptor, nextFollowUpAt: issues.monitorNextCheckAt })
      .from(issueApprovals).innerJoin(issues, eq(issues.id, issueApprovals.issueId))
      .where(and(eq(issueApprovals.companyId, companyId), eq(issues.companyId, companyId),
        inArray(issueApprovals.approvalId, ids))),
    agentIds.length ? db.select({ id: agents.id, name: agents.name, status: agents.status }).from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))) : [],
    replacementIds.length ? db.select({ id: approvals.id }).from(approvals)
      .where(and(eq(approvals.companyId, companyId), inArray(approvals.id, replacementIds))) : [],
    db.select({ approvalId: activityLog.entityId, details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog).where(and(eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "approval"), eq(activityLog.action, "approval.revision_outcome"),
        inArray(activityLog.entityId, ids))).orderBy(desc(activityLog.createdAt)),
  ]);
  const latestDecisionById = new Map<string, Date>();
  for (const decision of decisions) {
    if (!latestDecisionById.has(decision.approvalId)) latestDecisionById.set(decision.approvalId, decision.createdAt);
  }
  const tasksByApproval = new Map<string, ApprovalQueueAttention["tasks"]>();
  for (const { approvalId, unblockDescriptor, ...task } of links) {
    const tasks = tasksByApproval.get(approvalId) ?? [];
    tasks.push({ ...task,
      nextFollowUpAt: task.status === "done" || task.status === "cancelled" ? null : task.nextFollowUpAt,
      blockerAction: task.status === "blocked" && unblockDescriptor?.action
        ? redactSensitiveText(unblockDescriptor.action) : null,
    });
    tasksByApproval.set(approvalId, tasks);
  }
  const outcomesByApproval = new Map<string, typeof outcomes>();
  for (const event of outcomes) {
    const entries = outcomesByApproval.get(event.approvalId) ?? [];
    entries.push(event);
    outcomesByApproval.set(event.approvalId, entries);
  }
  const requesterById = new Map(requesters.map((agent) => [agent.id, agent]));
  const replacementSet = new Set(replacements.map((row) => row.id));
  for (const row of open) {
    const requester = row.requestedByAgentId ? requesterById.get(row.requestedByAgentId) : null;
    const tasks = tasksByApproval.get(row.id) ?? [];
    const replacement = typeof row.payload.supersededByApprovalId === "string"
      && row.payload.supersededByApprovalId !== row.id && replacementSet.has(row.payload.supersededByApprovalId)
      ? row.payload.supersededByApprovalId : null;
    result.set(row.id, {
      // Never substitute a payload edit time for a board revision decision.
      revisionRequestedAt: row.status === "revision_requested"
        ? latestDecisionById.get(row.id) ?? row.decidedAt : null,
      revisionOutcome: currentRevisionOutcome(row, outcomesByApproval.get(row.id) ?? []),
      owner: { agentId: requester?.id ?? null, userId: row.requestedByUserId,
        name: requester?.name ?? null, status: requester?.status ?? null },
      tasks,
      staleReasons: [
        ...(tasks.some((task) => task.status === "done" || task.status === "cancelled") ? ["linked_task_closed" as const] : []),
        ...(replacement ? ["explicitly_superseded" as const] : []),
      ],
      supersededByApprovalId: replacement,
    });
  }
  return result;
}

function strictDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date : null;
}

function safeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? redactSensitiveText(value.trim()) : null;
}

function currentRevisionOutcome(row: QueueRow, events: Array<{
  approvalId: string; details: Record<string, unknown> | null; createdAt: Date;
}>): ApprovalQueueAttention["revisionOutcome"] {
  if (row.status !== "revision_requested" || !row.decidedAt) return null;
  const event = events.find((candidate) => candidate.approvalId === row.id
    && strictDate(candidate.details?.revisionDecidedAt)?.getTime() === row.decidedAt!.getTime());
  const details = event?.details;
  if (!details || !event || typeof details.revisionKey !== "string" || !details.revisionKey.trim() || !["unresolved", "durable_blocker"].includes(String(details.outcome))) return null;
  const nextFollowUpAt = details.nextFollowUpAt == null ? null : strictDate(details.nextFollowUpAt);
  if (details.nextFollowUpAt != null && !nextFollowUpAt) return null;
  if (!Number.isSafeInteger(details.attemptCount) || (details.attemptCount as number) < 0
    || typeof details.executionActive !== "boolean" || details.requestedByAgentId !== row.requestedByAgentId) return null;
  const blocker = safeText(details.blocker);
  if (details.outcome === "durable_blocker" && !blocker) return null;
  return { outcome: details.outcome as "unresolved" | "durable_blocker", blocker,
    nextAction: safeText(details.nextAction), nextFollowUpAt,
    attemptCount: details.attemptCount as number, executionActive: details.executionActive,
    recordedAt: event.createdAt };
}

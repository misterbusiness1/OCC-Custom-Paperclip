import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issueCommentRequestEffects, issueCommentRequests, issues, workspaceOperations, type Db } from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";
import { conflict } from "../errors.js";
import type { CommentEffectHandler } from "./issue-comment-requests.js";
import { lockBoardCommentEffectClaim } from "./board-comment-effect-claim.js";
import { acquireExecutionWorkspaceLifecycleLock, bumpExecutionWorkspaceLifecycleGeneration,
  materializeClosedExecutionWorkspace, readExecutionWorkspaceLifecycleGeneration, setMetadataReopenPendingConsumption } from "./execution-workspaces.js";
import { BOARD_COMMENT_WORKSPACE_RESERVATION, hasBoardCommentWorkspaceReservation } from "./board-comment-workspace-reservation.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Request = typeof issueCommentRequests.$inferSelect;
type Effect = typeof issueCommentRequestEffects.$inferSelect;
type Workspace = typeof executionWorkspaces.$inferSelect;
function descriptor(effect: Effect) {
  const d = effect.descriptor;
  if (effect.kind !== "workspace_reopen" || d.version !== 1 || typeof d.workspaceId !== "string"
      || !(d.projectId === null || typeof d.projectId === "string")
      || Object.keys(d).some(key => !["version", "workspaceId", "projectId"].includes(key))) throw conflict("Invalid workspace reopen descriptor");
  return { workspaceId: d.workspaceId, projectId: d.projectId as string | null };
}
function fingerprint(row: Workspace) {
  return createHash("sha256").update(JSON.stringify([row.id, row.companyId, row.projectId, row.projectWorkspaceId,
    row.mode, row.strategyType, row.cwd, row.providerRef, row.repoUrl, row.baseRef, row.branchName])).digest("hex");
}
async function lockWorkspace(tx: Tx, companyId: string, workspaceId: string) {
  await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
  const [row] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspaceId),
    eq(executionWorkspaces.companyId, companyId))).for("update");
  if (!row) throw conflict("Accepted workspace is unavailable");
  return row;
}
function verifyOperation(operation: typeof workspaceOperations.$inferSelect | undefined, request: Request, effect: Effect, row: Workspace) {
  const m = operation?.metadata;
  if (!operation || operation.phase !== "board_comment_reopen" || operation.companyId !== request.companyId
      || operation.executionWorkspaceId !== row.id || m?.requestId !== request.id || m.effectId !== effect.id
      || m.resourceSha256 !== fingerprint(row)) throw conflict("Workspace operation identity changed");
  return m;
}
function verifyReservation(row: Workspace, effect: Effect, m: Record<string, unknown>) {
  const reservation = row.metadata?.[BOARD_COMMENT_WORKSPACE_RESERVATION] as Record<string, unknown> | undefined;
  if (reservation?.operationId !== effect.id || reservation.generation !== m.generation
      || readExecutionWorkspaceLifecycleGeneration(row.metadata) !== m.generation) throw conflict("Workspace reservation changed");
}
function receipt(request: Request, effect: Effect, row: Workspace, reopened: boolean) {
  return { version: 1, kind: "workspace_reopen", requestId: request.id, effectId: effect.id,
    workspaceId: row.id, reopened, generation: readExecutionWorkspaceLifecycleGeneration(row.metadata) };
}
/** Called only in admission's issue/request transaction after this pending effect was inserted. */
export async function reserveBoardCommentWorkspaceReopen(tx: Tx, request: Request, effect: Effect) {
  const d = descriptor(effect);
  if (effect.requestId !== request.id || effect.companyId !== request.companyId || effect.status !== "pending") throw conflict("Invalid workspace admission owner");
  const row = await lockWorkspace(tx, request.companyId, d.workspaceId);
  if (row.mode !== "isolated_workspace" || row.projectId !== d.projectId) throw conflict("Workspace is outside accepted project");
  if (hasBoardCommentWorkspaceReservation(row.metadata)) throw conflict("Workspace already has an accepted reopen reservation");
  const closed = ["archived", "cleanup_failed"].includes(row.status);
  if (closed) {
    const [physicalOperation] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, request.companyId), eq(workspaceOperations.executionWorkspaceId, row.id),
      eq(workspaceOperations.status, "running"))).limit(1);
    if (physicalOperation) throw conflict("Workspace has an active physical operation");
    const linked = await tx.select({ id: issues.id, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues).where(and(eq(issues.companyId, request.companyId), or(eq(issues.executionWorkspaceId, row.id),
        eq(issues.id, request.issueId), ...(row.sourceIssueId ? [eq(issues.id, row.sourceIssueId)] : []))));
    const linkedIssueIds = [...new Set([request.issueId, ...linked.map(item => item.id)])];
    const linkedRunIds = linked.flatMap(item => [item.checkoutRunId, item.executionRunId]).filter((id): id is string => !!id);
    const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, request.companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      or(...(linkedRunIds.length ? [inArray(heartbeatRuns.id, linkedRunIds)] : []), inArray(heartbeatRuns.nativeIssueId, linkedIssueIds), sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${row.id}`, inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, linkedIssueIds)))).limit(1);
    if (active) throw conflict("Workspace has an active execution owner");
  }
  const metadata = closed ? bumpExecutionWorkspaceLifecycleGeneration(row.metadata) : row.metadata;
  const generation = readExecutionWorkspaceLifecycleGeneration(metadata);
  const completedReceipt = closed ? null : receipt(request, effect, row, false);
  const at = new Date();
  await tx.insert(workspaceOperations).values({ id: effect.id, companyId: request.companyId, executionWorkspaceId: row.id,
    issueId: request.issueId, phase: "board_comment_reopen", status: closed ? "running" : "succeeded", finishedAt: closed ? null : at,
    metadata: { version: 1, requestId: request.id, effectId: effect.id, issueId: request.issueId,
      authorUserId: request.authorUserId, originalCleanupEligibleAt: row.cleanupEligibleAt?.toISOString() ?? null, generation, resourceSha256: fingerprint(row), phase: closed ? "reserved" : "completed",
      receipt: completedReceipt } });
  if (closed) await tx.update(executionWorkspaces).set({ metadata: { ...metadata,
    [BOARD_COMMENT_WORKSPACE_RESERVATION]: { operationId: effect.id, requestId: request.id, generation } },
    cleanupEligibleAt: null, updatedAt: at }).where(eq(executionWorkspaces.id, row.id));
}

export function createBoardCommentWorkspaceReopenHandler(db: Db): CommentEffectHandler {
  async function reconcile(request: Request, effect: Effect) {
    const d = descriptor(effect);
    const [operation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, effect.id),
      eq(workspaceOperations.companyId, request.companyId), eq(workspaceOperations.phase, "board_comment_reopen")));
    const m = operation?.metadata;
    const r = m?.receipt as Record<string, unknown> | undefined;
    return operation?.status === "succeeded" && m?.phase === "completed" && m.requestId === request.id
      && m.effectId === effect.id && r?.requestId === request.id && r.effectId === effect.id && r.workspaceId === d.workspaceId ? r : null;
  }
  return { reconcile, execute: async (request, effect) => {
    const existing = await reconcile(request, effect);
    if (existing) return existing;
    const d = descriptor(effect);
    const admitted = await db.transaction(async tx => {
      await lockBoardCommentEffectClaim(tx, { companyId: request.companyId, requestId: request.id,
        effectId: effect.id, generation: effect.generation, kind: "workspace_reopen" });
      const row = await lockWorkspace(tx, request.companyId, d.workspaceId);
      const [operation] = await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, effect.id)).for("update");
      const m = verifyOperation(operation, request, effect, row);
      verifyReservation(row, effect, m);
      if (m.phase !== "reserved" || operation!.status !== "running") throw conflict("Workspace materialization outcome requires reconciliation");
      await tx.update(workspaceOperations).set({ metadata: { ...m, phase: "executing", executingGeneration: effect.generation }, updatedAt: new Date() })
        .where(eq(workspaceOperations.id, effect.id));
      return { row, generation: Number(m.generation) };
    });
    const error = await materializeClosedExecutionWorkspace(db, admitted.row, { id: request.issueId },
      { agentId: null, actorType: "user" }, db, { operationId: effect.id, generation: admitted.generation });
    if (error) throw conflict("Workspace materialization failed; inspect the reserved operation before retrying");
    return db.transaction(async tx => {
      await lockBoardCommentEffectClaim(tx, { companyId: request.companyId, requestId: request.id,
        effectId: effect.id, generation: effect.generation, kind: "workspace_reopen" });
      const row = await lockWorkspace(tx, request.companyId, d.workspaceId);
      const [operation] = await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, effect.id)).for("update");
      const m = verifyOperation(operation, request, effect, row);
      verifyReservation(row, effect, m);
      if (m.phase !== "executing" || m.executingGeneration !== effect.generation) throw conflict("Workspace execution claim changed");
      const nextMetadata = { ...row.metadata };
      delete nextMetadata[BOARD_COMMENT_WORKSPACE_RESERVATION];
      await tx.update(executionWorkspaces).set({ status: "active", closedAt: null, cleanupReason: null, cleanupEligibleAt: null,
        metadata: setMetadataReopenPendingConsumption(nextMetadata, new Date()), updatedAt: new Date(), lastUsedAt: new Date() }).where(eq(executionWorkspaces.id, row.id));
      const audit = await persistActivity(tx as unknown as Db, { companyId: request.companyId,
        actorType: "user", actorId: request.authorUserId, responsibleUserIdOverride: request.responsibleUserId,
        action: "execution_workspace.reopened", entityType: "execution_workspace", entityId: row.id, issueId: request.issueId,
        details: { issueId: request.issueId, commentRequestId: request.id, effectId: effect.id,
          outcome: "reopened", generation: admitted.generation } });
      const result = { ...receipt(request, effect, row, true), workspaceActivityIds: [audit.activity.id] };
      await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(),
        metadata: { ...m, phase: "completed", receipt: result } }).where(eq(workspaceOperations.id, effect.id));
      return result;
    });
  } };
}

/** Release only a never-dispatched reservation. The operation outlives issue/comment deletion.
 * Caller owns issue/request locks where they still exist; no physical work occurs here. */
export async function cancelReservedBoardCommentWorkspaceReopen(tx: Tx, input: {
  companyId: string; operationId: string; requestId: string;
}) {
  const [snapshot] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, input.operationId),
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.phase, "board_comment_reopen")));
  if (!snapshot || snapshot.metadata?.requestId !== input.requestId) return { released: false, reason: "not_owned" };
  if (!snapshot.executionWorkspaceId) {
    const [operation] = await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, input.operationId)).for("update");
    if (operation?.metadata?.phase !== "reserved" || operation.status !== "running") return { released: false, reason: "dispatch_may_have_started" };
    await tx.update(workspaceOperations).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
      metadata: { ...operation.metadata, phase: "cancelled", cancellationReason: "workspace_removed" } }).where(eq(workspaceOperations.id, input.operationId));
    return { released: false, reason: "workspace_removed" };
  }
  const row = await lockWorkspace(tx, input.companyId, snapshot.executionWorkspaceId);
  const [operation] = await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, input.operationId)).for("update");
  const m = operation?.metadata;
  if (m?.phase !== "reserved" || operation?.status !== "running") return { released: false, reason: "dispatch_may_have_started" };
  const reservation = row.metadata?.[BOARD_COMMENT_WORKSPACE_RESERVATION] as Record<string, unknown> | undefined;
  if (reservation?.operationId !== input.operationId || reservation.generation !== m.generation
      || readExecutionWorkspaceLifecycleGeneration(row.metadata) !== m.generation || fingerprint(row) !== m.resourceSha256)
    return { released: false, reason: "resource_identity_changed" };
  const metadata = { ...row.metadata }; delete metadata[BOARD_COMMENT_WORKSPACE_RESERVATION];
  const originalCleanupEligibleAt = typeof m.originalCleanupEligibleAt === "string" ? new Date(m.originalCleanupEligibleAt) : null;
  if (originalCleanupEligibleAt && Number.isNaN(originalCleanupEligibleAt.getTime())) throw conflict("Invalid reserved cleanup timestamp");
  await tx.update(executionWorkspaces).set({ metadata, cleanupEligibleAt: originalCleanupEligibleAt, updatedAt: new Date() }).where(eq(executionWorkspaces.id, row.id));
  await tx.update(workspaceOperations).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
    metadata: { ...m, phase: "cancelled", cancellationReason: "never_dispatched" } }).where(eq(workspaceOperations.id, operation.id));
  return { released: true, reason: "never_dispatched" };
}

/** Bounded orphan scan: only ledger-deleted, never-dispatched operations are releasable. */
export async function recoverOrphanedBoardCommentWorkspaceReservations(db: Db, limit = 50) {
  const operations = await db.select({ id: workspaceOperations.id, companyId: workspaceOperations.companyId,
    requestId: sql<string>`${workspaceOperations.metadata}->>'requestId'` }).from(workspaceOperations)
    .where(and(eq(workspaceOperations.phase, "board_comment_reopen"), eq(workspaceOperations.status, "running"),
      sql`${workspaceOperations.metadata}->>'phase' = 'reserved'`,
      sql`not exists (select 1 from issue_comment_requests r where r.id::text = ${workspaceOperations.metadata}->>'requestId')`))
    .limit(Math.max(1, Math.min(100, limit)));
  let released = 0;
  for (const item of operations) await db.transaction(async tx => {
    const [owner] = await tx.select({ id: issueCommentRequests.id }).from(issueCommentRequests).where(eq(issueCommentRequests.id, item.requestId));
    if (owner) return;
    const result = await cancelReservedBoardCommentWorkspaceReopen(tx, { companyId: item.companyId, operationId: item.id, requestId: item.requestId });
    if (result.released) released++;
  });
  return { checked: operations.length, released };
}

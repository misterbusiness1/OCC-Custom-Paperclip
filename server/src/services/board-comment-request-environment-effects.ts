import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issueCommentRequestEffects, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { persistActivity } from "./activity-log.js";
import {
  acquireExecutionWorkspaceLifecycleLock,
  clearMetadataReopenPendingConsumption,
  metadataHasReopenPendingConsumption,
  readExecutionWorkspaceLifecycleGeneration,
} from "./execution-workspaces.js";
import type { CommentEffectHandler } from "./issue-comment-requests.js";
import { canonicalCommentMaterial } from "./issue-comment-request-canonical.js";
import { cancelReservedBoardCommentWorkspaceReopen } from "./board-comment-request-workspace-reopen.js";

type Transaction = Parameters<NonNullable<CommentEffectHandler["transaction"]>>[0];
type Lease = typeof environmentLeases.$inferSelect;
export interface BoardCommentSandboxCleanupTarget { leaseId: string; identitySha256: string }

function leaseIdentitySha256(lease: Lease) {
  return createHash("sha256").update(canonicalCommentMaterial({
    companyId: lease.companyId, environmentId: lease.environmentId, issueId: lease.issueId,
    executionWorkspaceId: lease.executionWorkspaceId, heartbeatRunId: lease.heartbeatRunId,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId, leasePolicy: lease.leasePolicy,
    acquiredAt: lease.acquiredAt.toISOString(), lastUsedAt: lease.lastUsedAt.toISOString(),
    updatedAt: lease.updatedAt.toISOString(), metadata: lease.metadata,
  })).digest("hex");
}

/** Capture exact resources during admission; a later delivery never discovers new leases. */
export async function captureBoardCommentSandboxCleanupTargets(tx: Transaction, input: {
  companyId: string; issueId: string; executionWorkspaceId: string | null;
}): Promise<BoardCommentSandboxCleanupTarget[]> {
  const rows = await tx.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.issueId, input.issueId),
    input.executionWorkspaceId ? eq(environmentLeases.executionWorkspaceId, input.executionWorkspaceId) : undefined,
    eq(environmentLeases.leasePolicy, "reuse_by_environment"),
    inArray(environmentLeases.status, ["active", "released", "retained", "pending_cleanup"]),
  )).limit(101).for("share");
  if (rows.length > 100) throw conflict("Sandbox cleanup requires a bounded resource plan");
  return rows.map(row => ({ leaseId: row.id, identitySha256: leaseIdentitySha256(row) }));
}

/** Transfer exact terminal resources to the existing durable cleanup queue.
 * No provider call occurs here, and the receipt never claims physical teardown. */
export function createBoardCommentSandboxCleanupHandler(): CommentEffectHandler {
  return { transaction: async (tx, request, effect) => {
    const descriptor = effect.descriptor;
    const targets = descriptor.leaseTargets;
    if (effect.kind !== "sandbox_cleanup" || effect.companyId !== request.companyId || effect.requestId !== request.id
      || descriptor.version !== 1 || !["done", "cancelled"].includes(String(descriptor.status))
      || !(descriptor.executionWorkspaceId === null || typeof descriptor.executionWorkspaceId === "string")
      || !Array.isArray(targets) || targets.length > 100
      || targets.some(t => !t || typeof t !== "object" || typeof t.leaseId !== "string"
        || !/^[a-f0-9]{64}$/.test(t.identitySha256) || Object.keys(t).some(k => !["leaseId", "identitySha256"].includes(k)))
      || new Set(targets.map(t => t.leaseId)).size !== targets.length
      || Object.keys(descriptor).some(k => !["version", "status", "executionWorkspaceId", "leaseTargets"].includes(k))) {
      throw conflict("Invalid sandbox cleanup identity");
    }
    // Match admission's issue-first order, including direct recovery callers.
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, request.issueId), eq(issues.companyId, request.companyId))).for("update");
    const [owner] = await tx.select().from(issueCommentRequestEffects).where(and(
      eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.requestId, request.id),
      eq(issueCommentRequestEffects.companyId, request.companyId),
    )).for("update");
    if (!owner || owner.kind !== effect.kind || owner.generation !== effect.generation
      || !["pending", "claimed"].includes(owner.status)
      || canonicalCommentMaterial(owner.descriptor) !== canonicalCommentMaterial(descriptor)) {
      throw conflict("Sandbox cleanup claim is no longer current");
    }
    const outcomes: { leaseId: string; disposition: string; holdingRunId?: string }[] = [];
    if (!issue || !["done", "cancelled"].includes(issue.status)) {
      return { version: 1, kind: "sandbox_cleanup", requestId: request.id, effectId: effect.id,
        cleanupAdmitted: false, destroyed: false, disposition: "issue_no_longer_terminal", outcomes };
    }
    for (const target of targets as BoardCommentSandboxCleanupTarget[]) {
      const [lease] = await tx.select().from(environmentLeases).where(and(
        eq(environmentLeases.id, target.leaseId), eq(environmentLeases.companyId, request.companyId),
      )).for("update");
      if (!lease) { outcomes.push({ leaseId: target.leaseId, disposition: "resource_removed" }); continue; }
      if (lease.issueId !== request.issueId || lease.leasePolicy !== "reuse_by_environment"
        || (descriptor.executionWorkspaceId !== null && lease.executionWorkspaceId !== descriptor.executionWorkspaceId)
        || leaseIdentitySha256(lease) !== target.identitySha256) {
        outcomes.push({ leaseId: lease.id, disposition: "resource_identity_changed" }); continue;
      }
      if (lease.heartbeatRunId) {
        const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, request.companyId),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        )).for("share");
        if (run) {
          outcomes.push({ leaseId: lease.id, disposition: "holding_run_finalizer_owns_cleanup", holdingRunId: run.id });
          continue;
        }
      }
      if (lease.status === "pending_cleanup") {
        outcomes.push({ leaseId: lease.id, disposition: "existing_cleanup_queue_owns_resource" }); continue;
      }
      if (!["active", "released", "retained"].includes(lease.status)) {
        outcomes.push({ leaseId: lease.id, disposition: "resource_already_terminal" }); continue;
      }
      const now = new Date();
      await tx.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed",
        failureReason: `issue_terminal_${issue.status}`, releasedAt: now, lastUsedAt: now, updatedAt: now,
        metadata: { ...lease.metadata, boardCommentCleanup: { requestId: request.id, effectId: effect.id,
          generation: effect.generation, acceptedIdentitySha256: target.identitySha256 } },
      }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, request.companyId)));
      outcomes.push({ leaseId: lease.id, disposition: "cleanup_admitted" });
    }
    return { version: 1, kind: "sandbox_cleanup", requestId: request.id, effectId: effect.id,
      cleanupAdmitted: outcomes.some(o => o.disposition === "cleanup_admitted"), destroyed: false, outcomes };
  } };
}

/** Cleanup has system recovery authority only over the fence this request created.
 * It never destroys a workspace or clears a later lifecycle's consumption fence.
 * The dispatcher commits the mutation, audit and completion receipt together. */
export function createBoardCommentWorkspaceCleanupHandler(): CommentEffectHandler {
  return { transaction: async (tx, request, effect) => {
    const descriptor = effect.descriptor;
    if (effect.kind !== "workspace_cleanup" || effect.companyId !== request.companyId
      || effect.requestId !== request.id || descriptor.version !== 1
      || typeof descriptor.workspaceId !== "string"
      || !Number.isSafeInteger(descriptor.reopenEffectOrdinal)
      || Number(descriptor.reopenEffectOrdinal) < 0 || Number(descriptor.reopenEffectOrdinal) >= effect.ordinal
      || Object.keys(descriptor).some(key => !["version", "workspaceId", "reopenEffectOrdinal"].includes(key))) {
      throw conflict("Invalid workspace cleanup identity");
    }
    const workspaceId = descriptor.workspaceId;
    const receipt = (disposition: string, workspaceActivityIds: string[] = []) => ({
      version: 1, kind: "workspace_cleanup", requestId: request.id, effectId: effect.id,
      workspaceId, disposition, workspaceActivityIds,
    });
    const [issue] = await tx.select({ status: issues.status }).from(issues).where(and(
      eq(issues.id, request.issueId), eq(issues.companyId, request.companyId),
    )).for("update");
    const [owner] = await tx.select().from(issueCommentRequestEffects).where(and(
      eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.requestId, request.id),
      eq(issueCommentRequestEffects.companyId, request.companyId),
    )).for("update");
    if (!owner || owner.generation !== effect.generation || owner.kind !== effect.kind
      || owner.descriptor.workspaceId !== workspaceId
      || owner.descriptor.reopenEffectOrdinal !== descriptor.reopenEffectOrdinal
      || !["pending", "claimed"].includes(owner.status)) throw conflict("Workspace cleanup claim is no longer current");
    const [reopen] = await tx.select().from(issueCommentRequestEffects).where(and(
      eq(issueCommentRequestEffects.requestId, request.id), eq(issueCommentRequestEffects.companyId, request.companyId),
      eq(issueCommentRequestEffects.ordinal, Number(descriptor.reopenEffectOrdinal)),
    )).for("update");
    if (!reopen || reopen.kind !== "workspace_reopen" || reopen.descriptor.workspaceId !== workspaceId) {
      throw conflict("Workspace cleanup has no matching reopen intent");
    }
    // Admission already reserved the resource. Cancellation must release that
    // exact reservation; ledger cancellation alone cannot prove cleanup.
    if (reopen.status === "cancelled" && !reopen.receipt) {
      const release = await cancelReservedBoardCommentWorkspaceReopen(tx, {
        companyId: request.companyId, operationId: reopen.id, requestId: request.id,
      });
      if (!release.released && release.reason !== "workspace_removed") {
        throw conflict("Cancelled workspace reservation cleanup is not proven");
      }
      if (!release.released) return receipt("workspace_removed");
      const audit = await persistActivity(tx as unknown as Db, {
        companyId: request.companyId, actorType: "user", actorId: request.authorUserId,
        responsibleUserIdOverride: request.responsibleUserId,
        action: "execution_workspace.reopen_cancelled", entityType: "execution_workspace", entityId: workspaceId,
        details: { issueId: request.issueId, commentRequestId: request.id, effectId: effect.id,
          reopenEffectId: reopen.id, recoveryCleanup: true, physicalExecutionStarted: false },
      });
      return receipt("reopen_cancelled_before_dispatch", [audit.activity.id]);
    }
    const accepted = reopen.receipt;
    if (reopen.status !== "delivered" || accepted?.version !== 1 || accepted.kind !== "workspace_reopen"
      || accepted.requestId !== request.id || accepted.effectId !== reopen.id || accepted.workspaceId !== workspaceId
      || typeof accepted.reopened !== "boolean" || !Number.isSafeInteger(accepted.generation)
      || Number(accepted.generation) < 0 || (accepted.reopened && Number(accepted.generation) < 1)) {
      throw conflict("Workspace reopen outcome is not proven");
    }
    if (!accepted.reopened) return receipt("reopen_owned_by_another_request");

    await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, request.companyId),
    )).for("update");
    if (!workspace) return receipt("workspace_removed");
    if (workspace.projectId !== reopen.descriptor.projectId || workspace.mode !== "isolated_workspace") {
      throw conflict("Workspace cleanup scope changed");
    }
    if (readExecutionWorkspaceLifecycleGeneration(workspace.metadata) !== accepted.generation) {
      return receipt("newer_workspace_lifecycle");
    }
    if (!metadataHasReopenPendingConsumption(workspace.metadata)) return receipt("already_consumed");
    const consumed = Boolean(issue && !["done", "cancelled"].includes(issue.status));
    await tx.update(executionWorkspaces).set({
      metadata: clearMetadataReopenPendingConsumption(workspace.metadata), updatedAt: new Date(),
    }).where(and(eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, request.companyId)));
    const audit = await persistActivity(tx as unknown as Db, {
      companyId: request.companyId, actorType: "user", actorId: request.authorUserId,
      responsibleUserIdOverride: request.responsibleUserId,
      action: consumed ? "execution_workspace.reopen_consumed" : "execution_workspace.reopen_unconsumed",
      entityType: "execution_workspace", entityId: workspaceId,
      details: { issueId: request.issueId, commentRequestId: request.id, effectId: effect.id,
        generation: accepted.generation, recoveryCleanup: true },
    });
    return receipt(consumed ? "consumed" : "unconsumed_fence_cleared", [audit.activity.id]);
  } };
}

import { lockBoardCommentEffectClaim } from "./board-comment-effect-claim.js";
import { and, eq } from "drizzle-orm";
import { issueComments, issues, issueCommentRequestEffects, issueCommentRequests, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { issueReferenceService } from "./issue-references.js";
import { externalObjectService } from "./external-objects.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { instanceSettingsService } from "./instance-settings.js";
import { authorizeBoardCommentRequest } from "./board-comment-request-authority.js";
import { loadActivityPublication, publishActivityObserved, persistActivity } from "./activity-log.js";
import { issueThreadInteractionService, publishDeferredInteractionResolutionTelemetry } from "./issue-thread-interactions.js";
import type { CommentEffectHandler } from "./issue-comment-requests.js";

/** Server-planned identity only. Content remains in the accepted governed comment. */
export interface BoardCommentReferenceDescriptor {
  version: 1;
  commentId: string;
}

type TransactionHandler = NonNullable<CommentEffectHandler["transaction"]>;
type Transaction = Parameters<TransactionHandler>[0];
type RequestRow = Parameters<TransactionHandler>[1];
type EffectRow = Parameters<TransactionHandler>[2];

async function acceptedReferenceComment(tx: Transaction, request: RequestRow, effect: EffectRow) {
  const descriptor = effect.descriptor;
  if (!["references", "confirmation_expiry", "terminal_interaction_expiry", "external_objects"].includes(effect.kind) || effect.companyId !== request.companyId || effect.requestId !== request.id
    || descriptor.version !== 1 || descriptor.commentId !== request.commentId
    || Object.keys(descriptor).some((key) => key !== "version" && key !== "commentId" && !(effect.kind === "terminal_interaction_expiry" && key === "interactionIds"))) {
    throw conflict("Invalid accepted comment reference effect", { code: "comment_request_effect_identity_invalid" });
  }
  const [comment] = await tx.select().from(issueComments).where(and(
    eq(issueComments.id, request.commentId), eq(issueComments.companyId, request.companyId),
    eq(issueComments.issueId, request.issueId),
  )).for("update");
  if (!comment || comment.deletedAt || request.contentInvalidatedAt
    || comment.authorUserId !== request.authorUserId || comment.createdByRunId !== null
    || comment.updatedAt.getTime() !== request.acceptedCommentUpdatedAt.getTime()) {
    throw conflict("Accepted comment content is no longer available", { code: "comment_request_content_changed" });
  }
  return comment;
}

/**
 * The dispatcher owns current-user authorization and claim-generation fencing.
 * All reference writes and this handler's receipt must use its same transaction.
 * No network provider, wake, publication, or replacement actor is introduced here.
 */
export function createBoardCommentReferenceHandler(): CommentEffectHandler {
  return {
    transaction: async (tx, request, effect) => {
      const comment = await acceptedReferenceComment(tx, request, effect);
      const references = issueReferenceService(tx as unknown as Db);
      const before = await references.listIssueReferenceSummary(request.issueId);
      await references.syncComment(comment.id, tx);
      const after = await references.listIssueReferenceSummary(request.issueId);
      const delta = references.diffIssueReferenceSummary(before, after);
      return {
        version: 1,
        kind: "references",
        companyId: request.companyId,
        issueId: request.issueId,
        requestId: request.id,
        effectId: effect.id,
        commentId: comment.id,
        generation: effect.generation,
        addedReferencedIssueIds: delta.addedReferencedIssues.map((issue) => issue.id),
        removedReferencedIssueIds: delta.removedReferencedIssues.map((issue) => issue.id),
        currentReferencedIssueIds: delta.currentReferencedIssues.map((issue) => issue.id),
      };
    },
  };
}

export function createBoardCommentProjectionHandlers() {
  return {
    references: createBoardCommentReferenceHandler(),
    confirmation_expiry: createBoardCommentExpiryHandler("confirmation_expiry"),
    terminal_interaction_expiry: createBoardCommentExpiryHandler("terminal_interaction_expiry"),
  };
}

/** Expiry and its deferred telemetry IDs commit with the effect receipt. */
export function createBoardCommentExpiryHandler(kind: "confirmation_expiry" | "terminal_interaction_expiry"): CommentEffectHandler {
  return { transaction: async (tx, request, effect) => {
    if (effect.kind !== kind) throw conflict("Unexpected expiry effect kind");
    const comment = await acceptedReferenceComment(tx, request, effect);
    const targetIds = effect.descriptor.interactionIds;
    if (kind === "terminal_interaction_expiry" && (!Array.isArray(targetIds)
      || targetIds.some((id) => typeof id !== "string") || new Set(targetIds).size !== targetIds.length)) {
      throw conflict("Terminal expiry requires immutable interaction targets");
    }
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, request.issueId),
      eq(issues.companyId, request.companyId))).for("update");
    if (!issue) throw conflict("Accepted issue no longer available");
    const service = issueThreadInteractionService(tx as unknown as Db);
    const deferred = { interactionIds: [] as string[] };
    const actor = { userId: request.authorUserId, agentId: null };
    const expired = kind === "confirmation_expiry"
      ? await service.expireRequestConfirmationsSupersededByComment(issue, comment, actor, deferred)
      : await service.expirePendingInteractionsForTerminalIssue(issue, actor, deferred, targetIds as string[]);
    const expiryActivityIds: string[] = [];
    for (const interaction of expired) {
      const { activity } = await persistActivity(tx as unknown as Db, {
        companyId: request.companyId, actorType: "user", actorId: request.authorUserId,
        responsibleUserIdOverride: request.responsibleUserId, action: "issue.thread_interaction_expired",
        entityType: "issue", entityId: request.issueId, details: {
          identifier: issue.identifier, interactionId: interaction.id, interactionKind: interaction.kind,
          interactionStatus: interaction.status, result: interaction.result ?? null,
          source: kind === "confirmation_expiry" ? "issue.comment" : "issue.status_transition.issue_closed",
          commentRequestId: request.id, commentId: request.commentId,
        },
      });
      expiryActivityIds.push(activity.id);
    }
    return { version: 1, kind, companyId: request.companyId, issueId: request.issueId,
      expiryActivityIds,
      requestId: request.id, effectId: effect.id, generation: effect.generation,
      expiredInteractionIds: expired.map((interaction) => interaction.id),
      deferredTelemetryInteractionIds: deferred.interactionIds };
  } };
}

/** Server-planned audit identity; expiry ordinals always resolve inside this request. */
export interface BoardCommentActivityPublicationDescriptor {
  version: 1;
  activityId: string;
  expiryEffectOrdinals?: number[];
  recoveryEffectOrdinals?: number[];
  workspaceEffectOrdinals?: number[];
  runtimeEffectOrdinals?: number[];
}

export function createBoardCommentActivityPublicationHandler(db: Db): CommentEffectHandler {
  return {
    execute: async (request, effect) => {
      const descriptor = effect.descriptor;
      const ordinals = descriptor.expiryEffectOrdinals ?? [];
      const recoveryOrdinals = descriptor.recoveryEffectOrdinals ?? [];
      const workspaceOrdinals = descriptor.workspaceEffectOrdinals ?? [];
      const runtimeOrdinals = descriptor.runtimeEffectOrdinals ?? [];
      if (effect.kind !== "activity_publication" || effect.companyId !== request.companyId
        || effect.requestId !== request.id || descriptor.version !== 1 || typeof descriptor.activityId !== "string"
        || Object.keys(descriptor).some(key => !["version", "activityId", "expiryEffectOrdinals", "recoveryEffectOrdinals", "workspaceEffectOrdinals", "runtimeEffectOrdinals"].includes(key))
        || !Array.isArray(ordinals) || ordinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= effect.ordinal)
        || new Set(ordinals).size !== ordinals.length
        || !Array.isArray(recoveryOrdinals) || recoveryOrdinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= effect.ordinal)
        || new Set(recoveryOrdinals).size !== recoveryOrdinals.length
        || !Array.isArray(workspaceOrdinals) || workspaceOrdinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= effect.ordinal)
        || new Set(workspaceOrdinals).size !== workspaceOrdinals.length
        || !Array.isArray(runtimeOrdinals) || runtimeOrdinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= effect.ordinal)
        || new Set(runtimeOrdinals).size !== runtimeOrdinals.length) throw conflict("Invalid activity publication identity");
      const publication = await loadActivityPublication(db, request.companyId, descriptor.activityId);
      const primaryDetails = publication?.payload.details as Record<string, unknown> | null;
      const primaryAction = publication?.payload.action;
      const validPrimaryAction = primaryAction === "issue.comment_added"
        || (primaryAction === "issue.updated" && ["comment", "auto_approval_comment"].includes(String(primaryDetails?.source)))
        || (primaryAction === "issue.thread_interaction_expired" && primaryDetails?.source === "issue.status_transition.issue_closed"
          && typeof primaryDetails?.interactionId === "string")
        || (primaryAction === "issue.inbox_archived" && primaryDetails?.source === "issue_status_done"
          && primaryDetails?.userId === request.authorUserId);
      if (!publication || publication.payload.entityType !== "issue" || publication.payload.entityId !== request.issueId
        || publication.payload.actorType !== "user" || publication.payload.actorId !== request.authorUserId
        || !validPrimaryAction
        || (publication.payload.details as Record<string, unknown> | null)?.commentId !== request.commentId) {
        throw conflict("Activity does not belong to the accepted comment");
      }
      if (publication.payload.action !== "issue.comment_added"
        && (ordinals.length || recoveryOrdinals.length || workspaceOrdinals.length || runtimeOrdinals.length)) {
        throw conflict("Dependent publications require the primary comment activity");
      }
      const receipts = await db.select().from(issueCommentRequestEffects).where(and(
        eq(issueCommentRequestEffects.companyId, request.companyId), eq(issueCommentRequestEffects.requestId, request.id),
      ));
      const interactionIds: string[] = primaryAction === "issue.thread_interaction_expired" ? [primaryDetails!.interactionId as string] : [];
      const expiryPublications = [];
      for (const ordinal of ordinals) {
        const source = receipts.find(row => row.ordinal === ordinal);
        const ids = source?.receipt?.deferredTelemetryInteractionIds;
        if (!source || !["confirmation_expiry", "terminal_interaction_expiry"].includes(source.kind)
          || source.status !== "delivered" || source.receipt?.requestId !== request.id || source.receipt?.effectId !== source.id
          || source.receipt?.kind !== source.kind || !Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
          throw conflict("Deferred telemetry receipt is unavailable");
        }
        interactionIds.push(...ids as string[]);
        const auditIds = source.receipt?.expiryActivityIds;
        if (!Array.isArray(auditIds) || auditIds.some(id => typeof id !== "string")) throw conflict("Expiry audit receipts are unavailable");
        for (const auditId of auditIds) {
          const audit = await loadActivityPublication(db, request.companyId, auditId as string);
          const details = audit?.payload.details as Record<string, unknown> | null;
          if (!audit || audit.payload.entityType !== "issue" || audit.payload.entityId !== request.issueId
            || audit.payload.actorType !== "user" || audit.payload.actorId !== request.authorUserId
            || audit.payload.action !== "issue.thread_interaction_expired" || details?.commentRequestId !== request.id) {
            throw conflict("Expiry audit does not belong to this request");
          }
          expiryPublications.push(audit);
        }
      }
      const recoveryPublications = [];
      for (const ordinal of recoveryOrdinals) {
        const source = receipts.find(row => row.ordinal === ordinal);
        if (!source || source.kind !== "source_recovery_revalidation" || source.status !== "delivered"
          || source.receipt?.requestId !== request.id || source.receipt?.effectId !== source.id
          || typeof source.receipt?.resolved !== "boolean") {
          throw conflict("Source recovery publication receipt is unavailable");
        }
        if (source.receipt?.resolved !== true) continue;
        const activityId = source.receipt.activityId;
        if (typeof activityId !== "string") throw conflict("Source recovery audit identity is unavailable");
        const audit = await loadActivityPublication(db, request.companyId, activityId);
        const details = audit?.payload.details as Record<string, unknown> | null;
        if (!audit || audit.payload.entityType !== "issue" || audit.payload.entityId !== request.issueId
          || audit.payload.actorType !== "user" || audit.payload.actorId !== request.authorUserId
          || audit.payload.action !== "issue.recovery_action_resolved" || details?.commentRequestId !== request.id) {
          throw conflict("Recovery activity does not belong to this request");
        }
        recoveryPublications.push(audit);
      }
      const workspacePublications = [];
      for (const ordinal of workspaceOrdinals) {
        const source = receipts.find(row => row.ordinal === ordinal);
        const ids = source?.receipt?.workspaceActivityIds ?? (source?.kind === "workspace_reopen" && source.receipt?.reopened === false ? [] : undefined);
        if (!source || !["workspace_cleanup", "workspace_reopen"].includes(source.kind) || source.status !== "delivered"
          || source.receipt?.requestId !== request.id || source.receipt?.effectId !== source.id
          || source.receipt?.kind !== source.kind || typeof source.receipt?.workspaceId !== "string"
          || !Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
          throw conflict("Workspace publication receipt is unavailable");
        }
        for (const activityId of ids) {
          const audit = await loadActivityPublication(db, request.companyId, activityId as string);
          const details = audit?.payload.details as Record<string, unknown> | null;
          if (!audit || audit.payload.entityType !== "execution_workspace" || audit.payload.entityId !== source.receipt.workspaceId
            || audit.payload.actorType !== "user" || audit.payload.actorId !== request.authorUserId
            || !(source.kind === "workspace_reopen" ? ["execution_workspace.reopened"] : ["execution_workspace.reopen_consumed", "execution_workspace.reopen_unconsumed", "execution_workspace.reopen_cancelled"]).includes(String(audit.payload.action))
            || details?.commentRequestId !== request.id) throw conflict("Workspace activity does not belong to this request");
          workspacePublications.push(audit);
        }
      }
      const runtimePublications = [];
      const runtimeSources: Record<string, string> = { interrupt: "issue_comment_interrupt",
        scheduled_retry_cancel: "issue_comment_scheduled_retry_superseded",
        cancel_native_question_run: "issue_status_transition_native_question" };
      for (const ordinal of runtimeOrdinals) {
        const source = receipts.find(row => row.ordinal === ordinal);
        const ids = source?.receipt?.runtimeActivityIds;
        if (!source || !Object.hasOwn(runtimeSources, source.kind) || source.status !== "delivered"
          || typeof source.receipt?.targetRunId !== "string" || !Array.isArray(ids) || ids.some(id => typeof id !== "string")) {
          throw conflict("Runtime publication receipt is unavailable");
        }
        for (const activityId of ids) {
          const audit = await loadActivityPublication(db, request.companyId, activityId as string);
          const details = audit?.payload.details as Record<string, unknown> | null;
          if (!audit || audit.payload.entityType !== "heartbeat_run" || audit.payload.entityId !== source.receipt.targetRunId
            || audit.payload.actorType !== "user" || audit.payload.actorId !== request.authorUserId
            || audit.payload.action !== "heartbeat.cancelled" || details?.requestId !== request.id
            || details?.effectId !== source.id || details?.commentId !== request.commentId
            || details?.targetRunId !== source.receipt.targetRunId || details?.source !== runtimeSources[source.kind]) {
            throw conflict("Runtime activity does not belong to this request");
          }
          runtimePublications.push(audit);
        }
      }
      const current = receipts.find(row => row.id === effect.id);
      if (!current || current.generation !== effect.generation || current.status !== "dispatching") {
        throw conflict("Activity publication claim is no longer current");
      }
      // The immutable, already committed audit is reconciliation work. Revocation
      // cannot rewrite its actor; stale attempts are never automatically replayed.
      await publishActivityObserved(publication);
      for (const audit of runtimePublications) await publishActivityObserved(audit);
      for (const audit of workspacePublications) await publishActivityObserved(audit);
      for (const audit of expiryPublications) await publishActivityObserved(audit);
      for (const audit of recoveryPublications) await publishActivityObserved(audit);
      await publishDeferredInteractionResolutionTelemetry(db, request.companyId, request.issueId, interactionIds);
      return { version: 1, kind: "activity_publication", activityId: descriptor.activityId,
        requestId: request.id, effectId: effect.id, generation: effect.generation,
        dispatchObserved: true, downstreamDeliveryConfirmed: false };
    },
    // No authoritative durable consumer receipt exists for live/plugin/analytics publication.
    reconcile: async () => null,
  };
}

export function createBoardCommentExternalObjectsHandler(db: Db, pluginWorkerManager?: PluginWorkerManager): CommentEffectHandler {
  const external = externalObjectService(db, { pluginWorkerManager, failOnDetectorError: true,
    enabled: async () => (await instanceSettingsService(db).getExperimental()).enableExternalObjects === true });
  async function current(tx: Transaction, request: RequestRow, effect: EffectRow) {
    await lockBoardCommentEffectClaim(tx, { companyId: request.companyId, requestId: request.id, effectId: effect.id, generation: effect.generation, kind: "external_objects" });
    const [accepted] = await tx.select().from(issueCommentRequests).where(and(
      eq(issueCommentRequests.id, request.id), eq(issueCommentRequests.companyId, request.companyId),
    )).for("update");
    if (!accepted || accepted.contentInvalidatedAt) throw conflict("Accepted external-object request is unavailable");
    const [row] = await tx.select().from(issueCommentRequestEffects).where(and(
      eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.requestId, request.id),
      eq(issueCommentRequestEffects.companyId, request.companyId),
    )).for("update");
    if (!row || row.kind !== "external_objects" || row.generation !== effect.generation || row.status !== "dispatching") {
      throw conflict("External-object claim is no longer current");
    }
    if (!(await authorizeBoardCommentRequest(tx, request))) throw conflict("External-object authority was revoked");
    return acceptedReferenceComment(tx, accepted, effect);
  }
  return {
    execute: async (request, effect) => {
      const comment = await db.transaction(tx => current(tx, request, effect));
      const projection = await external.prepareAcceptedCommentProjection(comment);
      return db.transaction(async tx => {
        await current(tx, request, effect);
        await external.applyAcceptedCommentProjection(projection, tx as unknown as Db);
        const receipt = { version: 1, kind: "external_objects", requestId: request.id, effectId: effect.id,
          commentId: comment.id, generation: effect.generation, enabled: projection.enabled,
          projectionCommitted: true, detectionCount: projection.detections.length };
        // Projection and its receipt are atomic; a crash after commit is receipt-only recovery.
        await tx.update(issueCommentRequestEffects).set({ receipt }).where(eq(issueCommentRequestEffects.id, effect.id));
        return receipt;
      });
    },
    reconcile: async (request, effect) => {
      const [row] = await db.select().from(issueCommentRequestEffects).where(and(
        eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.companyId, request.companyId),
        eq(issueCommentRequestEffects.requestId, request.id),
      ));
      const receipt = row?.receipt;
      return receipt?.kind === "external_objects" && receipt.requestId === request.id && receipt.effectId === effect.id
        && receipt.commentId === request.commentId && receipt.projectionCommitted === true ? receipt : null;
    },
  };
}

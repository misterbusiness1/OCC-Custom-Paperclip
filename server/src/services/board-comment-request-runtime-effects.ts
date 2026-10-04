import { boardCommentNativeStopProof, type BoardCommentNativeStopProof } from "./board-comment-native-stop-proof.js";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueCommentRequestEffects, issueCommentRequests, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";
import type { CommentEffectHandler, CommentEffectKind } from "./issue-comment-requests.js";
import { issueService } from "./issues.js";
import { REVIEW_PATH_RECOVERY_INSTRUCTION } from "./recovery/review-path-recovery.js";
import { persistActivity } from "./activity-log.js";
import { conflict } from "../errors.js";

type Heartbeat = Pick<ReturnType<typeof heartbeatService>, "cancelRun" | "wakeup" | "waitForRunExecutionDrain">;
type Request = Parameters<NonNullable<CommentEffectHandler["execute"]>>[0];
type Effect = Parameters<NonNullable<CommentEffectHandler["execute"]>>[1];
type WakeupOptions = NonNullable<Parameters<Heartbeat["wakeup"]>[1]>;
export interface BoardCommentCancellationDescriptor { version: 1; targetRunId: string; issueStatus?: string }
export interface BoardCommentWakeDescriptor {
  version: 1; agentId: string;
  skipIfSteeredOrdinal?: number;
  confirmationExpiryOrdinal?: number;
  wakeup: Pick<WakeupOptions, "source" | "triggerDetail" | "reason" | "payload" | "contextSnapshot" | "issueStateGuard">;
}
function cancellationDescriptor(effect: Effect): BoardCommentCancellationDescriptor {
  if (effect.descriptor.version !== 1 || typeof effect.descriptor.targetRunId !== "string"
      || Object.keys(effect.descriptor).some((key) => !["version", "targetRunId", ...(effect.kind === "cancel_native_question_run" ? ["issueStatus"] : [])].includes(key))) throw conflict("Invalid accepted cancellation descriptor");
  return effect.descriptor as unknown as BoardCommentCancellationDescriptor;
}
function wakeDescriptor(effect: Effect): BoardCommentWakeDescriptor {
  const value = effect.descriptor;
  if (value.version !== 1 || typeof value.agentId !== "string" || !value.wakeup || typeof value.wakeup !== "object"
      || Array.isArray(value.wakeup) || Object.keys(value).some((key) => !["version", "agentId", "wakeup", "skipIfSteeredOrdinal", "confirmationExpiryOrdinal"].includes(key))) throw conflict("Invalid accepted wake descriptor");
  for (const key of ["skipIfSteeredOrdinal", "confirmationExpiryOrdinal"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) >= effect.ordinal)) throw conflict("Invalid accepted wake dependency");
  }
  const wakeup = value.wakeup as Record<string, unknown>;
  if (Object.keys(wakeup).some((key) => !["source", "triggerDetail", "reason", "payload", "contextSnapshot", "issueStateGuard"].includes(key))
      || !["automation", "assignment"].includes(String(wakeup.source)) || wakeup.triggerDetail !== "system" || typeof wakeup.reason !== "string") throw conflict("Invalid accepted wake routing");
  return value as unknown as BoardCommentWakeDescriptor;
}
export function boardCommentRequestRuntimeEffects(db: Db, heartbeat: Heartbeat): Partial<Record<CommentEffectKind, CommentEffectHandler>> {
  async function currentEffect(request: Request, effect: Effect) {
    const [current] = await db.select({ id: issueCommentRequestEffects.id }).from(issueCommentRequestEffects).where(and(
      eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.requestId, request.id),
      eq(issueCommentRequestEffects.companyId, request.companyId), eq(issueCommentRequestEffects.status, "dispatching"),
      eq(issueCommentRequestEffects.generation, effect.generation)));
    if (!current) throw conflict("Accepted effect generation is no longer current");
  }
  async function recordCancellationCompletion(request: Request, effect: Effect, targetRunId: string, proof: "normal_control_and_drain" | BoardCommentNativeStopProof) {
    return db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, targetRunId), eq(heartbeatRuns.companyId, request.companyId))).for("update");
      const marker = run?.resultJson?.boardCommentCancellation as Record<string, unknown> | undefined;
      if (!run || marker?.effectId !== effect.id || marker.requestId !== request.id
          || !["cancelled", "succeeded", "failed", "timed_out"].includes(run.status)) throw conflict("Cancellation completion is not proven");
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId))).for("update");
      if (run.runtimeMode === "native") {
        const physicalProof = await boardCommentNativeStopProof(tx as unknown as Db, run, coordinator);
        if (!physicalProof) throw conflict("Native cancellation physical stop remains unproven");
        proof = physicalProof;
      }
      let completedAt = marker.completedAt;
      let activityIds = marker.runtimeActivityIds;
      if (typeof completedAt !== "string" || !Array.isArray(activityIds)) {
        const source = effect.kind === "interrupt" ? "issue_comment_interrupt"
          : effect.kind === "scheduled_retry_cancel" ? "issue_comment_scheduled_retry_superseded" : "issue_status_transition_native_question";
        const { activity } = await persistActivity(tx as unknown as Db, {
          companyId: request.companyId, actorType: "user", actorId: request.authorUserId,
          responsibleUserIdOverride: request.responsibleUserId, action: "heartbeat.cancelled",
          entityType: "heartbeat_run", entityId: targetRunId, issueId: request.issueId,
          details: { requestId: request.id, effectId: effect.id, commentId: request.commentId, targetRunId,
            issueId: request.issueId, source, agentId: run.agentId, proof,
            ...(effect.kind === "interrupt" ? { cancellationKind: "operator_interrupted", operatorInterrupted: true } : {}) },
        });
        completedAt = new Date().toISOString(); activityIds = [activity.id];
        await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson,
          boardCommentCancellation: { ...marker, completedAt, runtimeActivityIds: activityIds, proof },
        } }).where(eq(heartbeatRuns.id, run.id));
      }
      return { version: 1, kind: effect.kind, requestId: request.id, effectId: effect.id,
        targetRunId, cancellationRequestId: request.id, completedAt, runtimeActivityIds: activityIds };
    });
  }
  async function alreadyTerminalReceipt(request: Request, effect: Effect, target: typeof heartbeatRuns.$inferSelect) {
    if (!["succeeded", "cancelled", "timed_out"].includes(target.status)
      && !(target.status === "failed" && target.runtimeMode !== "native")) return null;
    if (target.runtimeMode === "native") {
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, target.id), eq(nativeRunFinalizations.companyId, target.companyId)));
      if (!(await boardCommentNativeStopProof(db, target, coordinator))) return null;
    }
    return { version: 1, kind: effect.kind, requestId: request.id, effectId: effect.id,
      targetRunId: target.id, disposition: "already_terminal", runtimeActivityIds: [] };
  }
  async function cancellationReceipt(request: Request, effect: Effect) {
    const descriptor = cancellationDescriptor(effect);
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, descriptor.targetRunId), eq(heartbeatRuns.companyId, request.companyId)));
    const marker = run?.resultJson?.boardCommentCancellation as Record<string, unknown> | undefined;
    if (!run) return null;
    if (!marker) return alreadyTerminalReceipt(request, effect, run);
    if (marker.requestId !== request.id || marker.effectId !== effect.id || marker.targetRunId !== run.id
        || marker.authorUserId !== request.authorUserId || !["cancelled", "succeeded", "failed", "timed_out"].includes(run.status)) return null;
    if (typeof marker.completedAt === "string") return { version: 1, kind: effect.kind, requestId: request.id, effectId: effect.id,
      targetRunId: run.id, cancellationRequestId: request.id, completedAt: marker.completedAt, runtimeActivityIds: marker.runtimeActivityIds ?? [] };
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId)));
    const physicalProof = await boardCommentNativeStopProof(db, run, coordinator);
    if (physicalProof) return recordCancellationCompletion(request, effect, run.id, physicalProof);
    return null;
  }
  const cancellation: CommentEffectHandler = {
    reconcile: cancellationReceipt,
    execute: async (request, effect) => {
      const descriptor = cancellationDescriptor(effect);
      await currentEffect(request, effect);
      const existing = await cancellationReceipt(request, effect);
      if (existing) return existing;
      const [target] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, descriptor.targetRunId), eq(heartbeatRuns.companyId, request.companyId)));
      if (!target) throw conflict("Accepted cancellation target disappeared");
      const terminalReceipt = await alreadyTerminalReceipt(request, effect, target);
      if (terminalReceipt) return terminalReceipt;
      if (target.runtimeMode === "native" && ["succeeded", "cancelled", "timed_out"].includes(target.status)) {
        throw conflict("Terminal native run has no authoritative stop proof");
      }
      const interrupted = effect.kind === "interrupt";
      const nativeQuestion = effect.kind === "cancel_native_question_run";
      if (nativeQuestion && !["done", "cancelled"].includes(String(descriptor.issueStatus))) throw conflict("Invalid native question cancellation status");
      const source = interrupted ? "issue_comment_interrupt" : nativeQuestion
        ? "issue_status_transition_native_question" : "issue_comment_scheduled_retry_superseded";
      const interruptActor = interrupted ? { interruptedByActorType: "user", interruptedByActorId: request.authorUserId } : {};
      await heartbeat.cancelRun(target.id, interrupted ? "Interrupted by board comment" : nativeQuestion
        ? "Task closed while waiting for operator input" : "Scheduled retry superseded by board comment", {
        boardCommentClaim: { companyId: request.companyId, requestId: request.id, effectId: effect.id, generation: effect.generation,
          kind: effect.kind as "interrupt" | "scheduled_retry_cancel" | "cancel_native_question_run" },
        errorCode: interrupted ? "operator_interrupted" : nativeQuestion ? "cancelled" : "scheduled_retry_superseded", suppressImmediateRecovery: true,
        resultJson: interrupted ? { operatorInterrupted: true, interruptionSource: source,
          interruptedIssueId: request.issueId, ...interruptActor }
          : nativeQuestion ? { cancelledByIssueStatus: descriptor.issueStatus, cancelledIssueId: request.issueId }
          : { scheduledRetrySupersededByComment: true, supersededIssueId: request.issueId },
        eventMessage: interrupted ? "run interrupted by board comment" : nativeQuestion ? "task closed while waiting for operator input" : "scheduled retry superseded by board comment",
        eventPayload: { issueId: request.issueId, source, requestId: request.id, commentId: request.commentId,
          requestedByActorType: "user", requestedByActorId: request.authorUserId, ...interruptActor },
      });
      await heartbeat.waitForRunExecutionDrain(target.id, { timeoutMs: 5_000 });
      return recordCancellationCompletion(request, effect, target.id, "normal_control_and_drain");
    },
  };
  async function wakeReceipt(request: Request, effect: Effect) {
    const descriptor = wakeDescriptor(effect);
    if (descriptor.skipIfSteeredOrdinal !== undefined) {
      const [steer] = await db.select().from(issueCommentRequestEffects).where(and(eq(issueCommentRequestEffects.requestId, request.id),
        eq(issueCommentRequestEffects.ordinal, descriptor.skipIfSteeredOrdinal), eq(issueCommentRequestEffects.kind, "steer"), eq(issueCommentRequestEffects.status, "delivered")));
      if (steer?.receipt?.steered === true) return { version: 1, disposition: "accepted_steer", steerEffectId: steer.id };
    }
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, request.companyId),
      eq(agentWakeupRequests.agentId, descriptor.agentId), eq(agentWakeupRequests.idempotencyKey, effect.idempotencyKey)));
    return wake ? { version: 1, wakeRequestId: wake.id, status: wake.status, runId: wake.runId, durableAdmission: true } : null;
  }
  return {
    interrupt: cancellation, scheduled_retry_cancel: cancellation, cancel_native_question_run: cancellation,
    wake: { reconcile: wakeReceipt, execute: async (request, effect) => {
      const descriptor = wakeDescriptor(effect);
      await currentEffect(request, effect);
      const existing = await wakeReceipt(request, effect);
      if (existing) return existing;
      if (descriptor.skipIfSteeredOrdinal !== undefined) {
        if (!Number.isSafeInteger(descriptor.skipIfSteeredOrdinal) || descriptor.skipIfSteeredOrdinal < 0 || descriptor.skipIfSteeredOrdinal >= effect.ordinal) throw conflict("Invalid accepted steering dependency");
        const [steer] = await db.select().from(issueCommentRequestEffects).where(and(eq(issueCommentRequestEffects.requestId, request.id),
          eq(issueCommentRequestEffects.ordinal, descriptor.skipIfSteeredOrdinal), eq(issueCommentRequestEffects.kind, "steer"), eq(issueCommentRequestEffects.status, "delivered")));
        if (!steer) throw conflict("Accepted steering disposition is unavailable");
        if (steer.receipt?.steered === true) return { version: 1, disposition: "accepted_steer", steerEffectId: steer.id };
      }
      let wakeup = descriptor.wakeup;
      if (descriptor.confirmationExpiryOrdinal !== undefined && wakeup.reason === "issue_commented") {
        const [expiry] = await db.select().from(issueCommentRequestEffects).where(and(eq(issueCommentRequestEffects.requestId, request.id),
          eq(issueCommentRequestEffects.ordinal, descriptor.confirmationExpiryOrdinal), eq(issueCommentRequestEffects.kind, "confirmation_expiry"), eq(issueCommentRequestEffects.status, "delivered")));
        if (!expiry || !Array.isArray(expiry.receipt?.expiredInteractionIds)) throw conflict("Accepted confirmation expiry is unavailable");
        const ids = expiry.receipt.expiredInteractionIds.filter((id): id is string => typeof id === "string").sort();
        const service = issueService(db); const currentIssue = await service.getById(request.issueId);
        if (currentIssue?.status === "in_review" && ids.length && (await service.listReviewAttention(request.companyId, [currentIssue])).get(request.issueId)?.state === "stalled") {
          const review = { reviewPathLost: true, reviewPathConsumedRef: ids.length === 1 ? ids[0] : `interactions:${ids.join(",")}`,
            reviewPathInstruction: REVIEW_PATH_RECOVERY_INSTRUCTION };
          wakeup = { ...wakeup, payload: { ...wakeup.payload, ...review }, contextSnapshot: { ...wakeup.contextSnapshot, ...review } };
        }
      }
      await heartbeat.wakeup(descriptor.agentId, { ...wakeup,
        idempotencyKey: effect.idempotencyKey, requestedByActorType: "user", requestedByActorId: request.authorUserId,
        boardCommentClaim: { requestId: request.id, effectId: effect.id, generation: effect.generation } });
      const receipt = await wakeReceipt(request, effect);
      if (!receipt) throw conflict("Wake did not produce a durable admission receipt");
      return receipt;
    } },
  };
}

/** A watchdog may create its concrete review target only while delivering.
 * Append that target's normal wake to the same durable request under its claim;
 * do not call heartbeat while holding the watchdog mutation transaction. */
export async function appendBoardCommentWatchdogWake(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  request: Request, parentEffect: Effect, descriptor: BoardCommentWakeDescriptor,
) {
  if (parentEffect.kind !== "watchdog" || parentEffect.requestId !== request.id || parentEffect.companyId !== request.companyId)
    throw conflict("Invalid watchdog wake parent");
  const [owner] = await tx.select({ id: issueCommentRequests.id }).from(issueCommentRequests).where(and(
    eq(issueCommentRequests.id, request.id), eq(issueCommentRequests.companyId, request.companyId), eq(issueCommentRequests.status, "pending"),
  )).for("update");
  if (!owner) throw conflict("Watchdog request is no longer pending");
  const [parent] = await tx.select().from(issueCommentRequestEffects).where(and(
    eq(issueCommentRequestEffects.id, parentEffect.id), eq(issueCommentRequestEffects.requestId, request.id),
    eq(issueCommentRequestEffects.generation, parentEffect.generation), eq(issueCommentRequestEffects.status, "dispatching"),
  )).for("update");
  if (!parent) throw conflict("Watchdog claim is no longer current");
  const targetIssueId = descriptor.wakeup.payload?.issueId;
  if (typeof targetIssueId !== "string") throw conflict("Watchdog wake requires an immutable issue target");
  const key = `issue-comment-request:${request.id}:watchdog:${parentEffect.id}:${targetIssueId}:${descriptor.agentId}`;
  const [existing] = await tx.select({ id: issueCommentRequestEffects.id }).from(issueCommentRequestEffects)
    .where(and(eq(issueCommentRequestEffects.companyId, request.companyId), eq(issueCommentRequestEffects.idempotencyKey, key)));
  if (existing) return existing.id;
  const [last] = await tx.select({ next: sql<number>`coalesce(max(${issueCommentRequestEffects.ordinal}), -1) + 1` })
    .from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, request.id));
  const [inserted] = await tx.insert(issueCommentRequestEffects).values({ companyId: request.companyId,
    requestId: request.id, ordinal: Number(last.next), kind: "wake", descriptor: descriptor as unknown as Record<string, unknown>, idempotencyKey: key,
  }).returning({ id: issueCommentRequestEffects.id });
  return inserted.id;
}

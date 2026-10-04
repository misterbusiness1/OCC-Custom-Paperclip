import { assertStartupWorkAllowed, isStartupWorkHeld } from "./startup-work-barrier.js";
import { reserveBoardCommentWorkspaceReopen } from "./board-comment-request-workspace-reopen.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  issueCommentRequests, issueCommentRequestEffects, issueComments,
  issues, instanceSettings, type Db,
} from "@paperclipai/db";
import { instanceSettingsService } from "./instance-settings.js";
import { currentUserRedactionProfileSha256, redactCurrentUserText } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { HttpError, conflict, forbidden, notFound, unprocessable } from "../errors.js";

export { BOARD_COMMENT_REQUEST_PROTOCOL_VERSION } from "./issue-comment-request-canonical.js";
import { acceptedCommentDigest, assertSameAcceptedComment, canonicalCommentMaterial, resolveCommentAttachmentIdentities, type CommentRequestEnvelope } from "./issue-comment-request-canonical.js";

type RequestRow = typeof issueCommentRequests.$inferSelect;
type EffectRow = typeof issueCommentRequestEffects.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CommentEffectKind = "workspace_reopen" | "interrupt" | "references" | "steer" | "wake" | "watchdog" | "activity_publication" | "confirmation_expiry"
  | "external_objects" | "terminal_interaction_expiry" | "source_recovery_revalidation" | "cancel_native_question_run"
  | "workspace_cleanup" | "sandbox_cleanup" | "scheduled_retry_cancel";
export interface CommentRequestInput {
  companyId: string;
  issueId: string;
  authorUserId: string;
  clientRequestId: string;
  /** Server-derived accountable identity, never read from request JSON. */
  responsibleUserId?: string | null;
  actorSource?: string;
  authorizationDecision?: string;
  normalization?: CommentRequestEnvelope["normalization"];
  body: string;
  attachmentIds?: string[];
  interrupt?: boolean;
  resume?: boolean;
  reopen?: boolean;
  authorType?: string | null;
  presentation?: unknown;
  metadata?: unknown;
}
export interface CommentEffectPlan {
  kind: CommentEffectKind;
  /** Server-derived routing only: no credentials, raw content, or executable commands. */
  descriptor: Record<string, unknown>;
}

export { boardCommentRequestControls } from "./board-comment-request-operational.js";
import { boardCommentRequestControls, trackBoardCommentRequestOperation } from "./board-comment-request-operational.js";

export interface CommentEffectHandler {
  /** Database-local operation; execution and completion receipt commit together. */
  transaction?: (tx: Transaction, request: RequestRow, effect: EffectRow) => Promise<Record<string, unknown>>;
  /** External control-plane operation. A dispatching claim is never automatically replayed. */
  execute?: (request: RequestRow, effect: EffectRow) => Promise<Record<string, unknown>>;
  /** Reconcile from authoritative durable evidence; may record proven database settlement, never repeat the external action. */
  reconcile?: (request: RequestRow, effect: EffectRow) => Promise<Record<string, unknown> | null>;
}

export function issueCommentRequestService(db: Db, options: {
  authorize: (tx: Transaction, request: Pick<RequestRow, "companyId" | "issueId" | "authorUserId">) => Promise<boolean>;
  handlers: Partial<Record<CommentEffectKind, CommentEffectHandler>>;
  now?: () => Date;
  staleClaimMs?: number;
  /** Injection for deterministic control tests; serving instances use environment controls. */
  controls?: typeof boardCommentRequestControls;
}) {
  const controls = options.controls ?? boardCommentRequestControls;
  const event = (name: string, fields: Record<string, unknown>) => logger.info({ event: `board_comment_request.${name}`, ...fields }, "Board comment request state");
  const now = options.now ?? (() => new Date());
  const staleClaimMs = options.staleClaimMs ?? 30_000;

  async function settleRequest(tx: Transaction, requestId: string) {
    const remaining = await tx.select({ status: issueCommentRequestEffects.status, lastErrorCode: issueCommentRequestEffects.lastErrorCode })
      .from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, requestId));
    const status = remaining.some((row) => row.status === "reconciliation_required") ? "reconciliation_required"
      : remaining.some((row) => row.status === "blocked") ? "blocked"
      : remaining.some((row) => row.status === "cancelled") ? "cancelled"
      : remaining.every((row) => row.status === "delivered") ? "delivered" : "pending";
    await tx.update(issueCommentRequests).set({ status, lastErrorCode: remaining.find((row) => row.lastErrorCode)?.lastErrorCode ?? null, updatedAt: now() })
      .where(eq(issueCommentRequests.id, requestId));
  }

  return {
    /** The callback may perform database-local work only, on the supplied transaction. */
    async admit(input: CommentRequestInput, persist: (
      tx: Transaction, issue: typeof issues.$inferSelect,
      normalization: { body: string; censorUsername: boolean },
    ) => Promise<{ commentId: string; effects: CommentEffectPlan[]; sourceTrust?: Record<string, unknown> | null }>) {
      return trackBoardCommentRequestOperation("admission", async () => {
      assertStartupWorkAllowed();
      if (!input.authorUserId || !input.clientRequestId) throw forbidden("Authenticated request identity required");
      if (input.authorType != null && input.authorType !== "user") throw unprocessable("Comment authorType must match authenticated actor");
      const result = await db.transaction(async (tx) => {
        const [issue] = await tx.select().from(issues).where(and(
          eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
        )).for("update");
        if (!issue) throw notFound("Issue not found");
        if (issue.conversationAgentId) throw conflict("Conversation comments use their own delivery protocol");
        if (!(await options.authorize(tx, input))) throw forbidden("Comment request is no longer authorized");
        if (!controls().admission) throw new HttpError(503, "Board comment request admission is paused", { code: "board_comment_request_admission_paused" });
        const [existing] = await tx.select().from(issueCommentRequests).where(and(
          eq(issueCommentRequests.companyId, input.companyId), eq(issueCommentRequests.issueId, input.issueId),
          eq(issueCommentRequests.authorUserId, input.authorUserId), eq(issueCommentRequests.clientRequestId, input.clientRequestId),
        ));
        const acceptedNormalization = existing
          ? (existing.canonicalEnvelope as unknown as CommentRequestEnvelope).normalization
          : input.normalization ?? null;
        const censorUsername = acceptedNormalization?.censorUsername
          ?? (await instanceSettingsService(tx as unknown as Db).getGeneral()).censorUsernameInLogs;
        const normalization = { version: 1 as const, censorUsername,
          profileSha256: currentUserRedactionProfileSha256(censorUsername) };
        if (acceptedNormalization && acceptedNormalization.profileSha256 !== normalization.profileSha256) {
          throw conflict("Accepted comment normalization profile is unavailable", { code: "comment_request_normalization_unavailable" });
        }
        const normalizedBody = redactCurrentUserText(input.body, { enabled: censorUsername });
        const envelope = async (commentId?: string): Promise<CommentRequestEnvelope> => ({
          version: 1, companyId: input.companyId, issueId: input.issueId,
          authorUserId: input.authorUserId, responsibleUserId: input.responsibleUserId ?? input.authorUserId,
          authorization: { source: input.actorSource ?? "session", decision: input.authorizationDecision ?? "company_operator", policyVersion: 1 },
          normalization,
          interrupt: input.interrupt === true, resume: input.resume === true, reopen: input.reopen === true,
          authorType: "user", attachments: await resolveCommentAttachmentIdentities(tx, {
            companyId: input.companyId, issueId: input.issueId, attachmentIds: input.attachmentIds ?? [], commentId,
          }),
        });
        if (existing) {
          const [comment] = await tx.select().from(issueComments).where(and(
            eq(issueComments.id, existing.commentId), eq(issueComments.companyId, input.companyId),
          )).for("update");
          if (!comment || comment.deletedAt) throw new HttpError(410, "Accepted comment was deleted", { code: "comment_request_deleted" });
          if (existing.contentInvalidatedAt || comment.updatedAt.getTime() !== existing.acceptedCommentUpdatedAt.getTime()) {
            throw conflict("Accepted comment content changed", { code: "comment_request_content_changed" });
          }
          const receivedEnvelope = await envelope(comment.id);
          const material = { body: normalizedBody, presentation: input.presentation ?? null, metadata: input.metadata ?? null };
          assertSameAcceptedComment({ envelope: existing.canonicalEnvelope as unknown as CommentRequestEnvelope,
            material: { body: comment.body, presentation: comment.presentation, metadata: comment.metadata }, digest: existing.payloadSha256 },
            { envelope: receivedEnvelope, material, digest: acceptedCommentDigest(receivedEnvelope, material) });
          return { request: existing, duplicate: true };
        }
        // Never invent intent for a historical comment accepted by an older server.
        const [legacy] = await tx.select().from(issueComments).where(and(
          eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
          eq(issueComments.authorUserId, input.authorUserId), eq(issueComments.clientRequestId, input.clientRequestId),
        ));
        if (legacy) {
          if (legacy.deletedAt) throw new HttpError(410, "Accepted comment was deleted", { code: "comment_request_deleted" });
          if (legacy.body !== normalizedBody) throw conflict("Message request ID was already used for different content", { code: "comment_request_conflict" });
          throw conflict("Existing comment predates durable request delivery", { code: "legacy_comment_request", commentId: legacy.id });
        }
        const acceptedEnvelope = await envelope();
        const accepted = await persist(tx, issue, { body: normalizedBody, censorUsername });
        const [comment] = await tx.select().from(issueComments).where(and(
          eq(issueComments.id, accepted.commentId), eq(issueComments.companyId, input.companyId),
          eq(issueComments.issueId, input.issueId), eq(issueComments.authorUserId, input.authorUserId),
          eq(issueComments.clientRequestId, input.clientRequestId),
        ));
        if (!comment || comment.deletedAt) throw conflict("Accepted request comment identity is invalid");
        const requestId = randomUUID();
        const [request] = await tx.insert(issueCommentRequests).values({
          id: requestId, companyId: input.companyId, issueId: input.issueId,
          authorUserId: input.authorUserId, clientRequestId: input.clientRequestId,
          payloadSha256: acceptedCommentDigest(acceptedEnvelope, { body: comment.body, presentation: comment.presentation, metadata: comment.metadata }),
          canonicalEnvelope: acceptedEnvelope as unknown as Record<string, unknown>, acceptedCommentUpdatedAt: comment.updatedAt,
          commentId: comment.id,
          responsibleUserId: input.responsibleUserId ?? input.authorUserId, sourceTrust: accepted.sourceTrust ?? null,
          status: accepted.effects.length ? "pending" : "delivered",
        }).returning();
        await raiseBoardCommentProtocolFloor(tx, 1);
        if (accepted.effects.length) {
          const insertedEffects = await tx.insert(issueCommentRequestEffects).values(accepted.effects.map((effect, ordinal) => ({
            companyId: input.companyId, requestId, ordinal, kind: effect.kind, descriptor: effect.descriptor,
            idempotencyKey: `issue-comment-request:${requestId}:${ordinal}`,
          }))).returning();
          for (const effect of insertedEffects) {
            if (effect.kind === "workspace_reopen") await reserveBoardCommentWorkspaceReopen(tx, request!, effect);
          }
        }
        return { request: request!, duplicate: false };
      }).catch(error => {
        if (error instanceof HttpError && [403, 409, 410, 503].includes(error.status)) {
          const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
          event(error.status === 409 ? "conflict" : "blocked", { companyId: input.companyId, issueId: input.issueId,
            code: typeof details.code === "string" ? details.code : `http_${error.status}` });
        }
        throw error;
      });
      event(result.duplicate ? "replay" : "accepted", { companyId: result.request.companyId, requestId: result.request.id, status: result.request.status });
      return result;
      });
    },

    /** One bounded effect per invocation; repeated recovery passes drain the ordered outbox. */
    async dispatchOne(companyId: string, requestId: string) {
      return trackBoardCommentRequestOperation("dispatch", async () => {
      if (isStartupWorkHeld() || !controls().dispatch) return;
      const claimed = await db.transaction(async (tx) => {
        const [identity] = await tx.select({ issueId: issueCommentRequests.issueId }).from(issueCommentRequests)
          .where(and(eq(issueCommentRequests.id, requestId), eq(issueCommentRequests.companyId, companyId)));
        if (!identity) return null;
        await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, identity.issueId), eq(issues.companyId, companyId))).for("update");
        const [request] = await tx.select().from(issueCommentRequests).where(and(
          eq(issueCommentRequests.id, requestId), eq(issueCommentRequests.companyId, companyId),
        )).for("update");
        if (!request) return null;
        const outstanding = await tx.select().from(issueCommentRequestEffects).where(and(
          eq(issueCommentRequestEffects.requestId, request.id),
          sql`${issueCommentRequestEffects.status} <> 'delivered'`,
        )).orderBy(asc(issueCommentRequestEffects.ordinal)).for("update");
        const cleanupKinds = new Set(["workspace_cleanup", "sandbox_cleanup"]);
        const first = outstanding[0];
        const effect = request.status === "pending" && first && !["blocked", "cancelled", "reconciliation_required"].includes(first.status)
          ? first : outstanding.find((row) => row.status === "dispatching"
            || (row.status === "reconciliation_required" && row.attemptCount < 8 && row.updatedAt.getTime() <= now().getTime() - 30_000)
            || (cleanupKinds.has(row.kind) && ["pending", "claimed"].includes(row.status)));
        if (!effect) { await settleRequest(tx, request.id); return null; }
        if (effect.claimedAt && effect.claimedAt.getTime() > now().getTime() - staleClaimMs &&
            ["claimed", "dispatching"].includes(effect.status)) return null;
        const [comment] = await tx.select().from(issueComments)
          .where(and(eq(issueComments.id, request.commentId), eq(issueComments.companyId, companyId))).for("update");
        const deleted = !comment || comment.deletedAt !== null;
        let invalidReason: string | null = deleted ? "comment_deleted" : null;
        if (comment && !deleted) {
          const envelope = request.canonicalEnvelope as unknown as CommentRequestEnvelope;
          if (request.contentInvalidatedAt || comment.updatedAt.getTime() !== request.acceptedCommentUpdatedAt.getTime()
              || acceptedCommentDigest(envelope, { body: comment.body, presentation: comment.presentation, metadata: comment.metadata }) !== request.payloadSha256) {
            invalidReason = "comment_request_content_changed";
          } else {
            try {
              const attachments = await resolveCommentAttachmentIdentities(tx, { companyId, issueId: request.issueId,
                commentId: comment.id, attachmentIds: envelope.attachments.map((item) => item.attachmentId) });
              if (canonicalCommentMaterial(attachments) !== canonicalCommentMaterial(envelope.attachments)) invalidReason = "comment_request_attachment_changed";
            } catch (error) {
              if (!(error instanceof HttpError) || error.status !== 409) throw error;
              invalidReason = "comment_request_attachment_changed";
            }
          }
        }
        const authorized = !invalidReason && await options.authorize(tx, request);
        // Already dispatched work has crossed the uncertain boundary. Revocation
        // forbids new execution, but does not erase a receipt that already exists.
        // The recovery branch below is strictly receipt-only in this case.
        if ((invalidReason || !authorized) && !["dispatching", "reconciliation_required"].includes(effect.status) && !cleanupKinds.has(effect.kind)) {
          await tx.update(issueCommentRequestEffects).set({
            status: invalidReason ? "cancelled" : "blocked", lastErrorCode: invalidReason ?? "authorization_revoked", updatedAt: now(),
          }).where(and(eq(issueCommentRequestEffects.requestId, request.id), sql`${issueCommentRequestEffects.status} in ('pending', 'claimed')`,
            sql`${issueCommentRequestEffects.kind} not in ('workspace_cleanup', 'sandbox_cleanup')`));
          await settleRequest(tx, request.id);
          return { blocked: { companyId, requestId, effectId: effect.id, kind: effect.kind,
            code: invalidReason ?? "authorization_revoked" } };
        }
        const handler = options.handlers[effect.kind as CommentEffectKind];
        if (!handler) throw new Error(`Unsupported durable comment effect: ${effect.kind}`);
        if (handler.transaction && !["dispatching", "reconciliation_required"].includes(effect.status)) {
          const receipt = await handler.transaction(tx, request, effect);
          await tx.update(issueCommentRequestEffects).set({ status: "delivered", receipt, updatedAt: now() })
            .where(eq(issueCommentRequestEffects.id, effect.id));
          await settleRequest(tx, request.id);
          return null;
        }
        const reconcile = ["dispatching", "reconciliation_required"].includes(effect.status);
        if (reconcile) event("claim_expired", { requestId: request.id, effectId: effect.id, kind: effect.kind, generation: effect.generation });
        const [updated] = await tx.update(issueCommentRequestEffects).set({
          status: "claimed", generation: effect.generation + 1, attemptCount: effect.attemptCount + 1,
          claimedAt: now(), updatedAt: now(),
        }).where(eq(issueCommentRequestEffects.id, effect.id)).returning();
        return { request, effect: updated!, handler, reconcile };
      });
      if (!claimed) return;
      if (claimed.blocked) { event("blocked", claimed.blocked); return; }
      const { request, effect, handler } = claimed;
      // Persist the uncertain boundary before crossing it. An expired dispatcher
      // is reconciled, never automatically re-executed by another generation.
      const [dispatch] = await db.update(issueCommentRequestEffects).set({ status: "dispatching", updatedAt: now() }).where(and(
        eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.generation, effect.generation),
        eq(issueCommentRequestEffects.status, "claimed"),
      )).returning();
      if (!dispatch) return;
      let receipt: Record<string, unknown> | null = null;
      let errorCode: string | null = null;
      // Keep a live external dispatcher from being mistaken for a crashed one.
      // Renew only this generation and never overlap renewal queries. A lost
      // claim cannot be restored by an old worker; completion still uses CAS.
      let renewal: Promise<void> | null = null;
      const renewalTimer = setInterval(() => {
        if (renewal) return;
        renewal = db.update(issueCommentRequestEffects).set({ claimedAt: now(), updatedAt: now() }).where(and(
          eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.generation, effect.generation),
          eq(issueCommentRequestEffects.status, "dispatching"),
        )).then(() => undefined).catch(() => {
          event("claim_renewal_failed", { requestId: request.id, effectId: effect.id, generation: effect.generation });
        }).finally(() => { renewal = null; });
      }, Math.max(10, Math.floor(staleClaimMs / 3)));
      renewalTimer.unref();
      try {
        receipt = claimed.reconcile ? await handler.reconcile?.(request, effect) ?? null
          : await handler.execute?.(request, effect) ?? null;
        if (!receipt) errorCode = "effect_outcome_ambiguous";
      } catch {
        // A durable receipt can exist even when its caller lost the response.
        // Reconcile proven durable settlement; never repeat the external action here.
        try { receipt = await handler.reconcile?.(request, effect) ?? null; } catch { receipt = null; }
        if (!receipt) errorCode = "effect_outcome_ambiguous";
      } finally {
        clearInterval(renewalTimer);
        if (renewal) await renewal;
      }
      await db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, request.issueId), eq(issues.companyId, request.companyId))).for("update");
        const [owner] = await tx.select({ id: issueCommentRequests.id }).from(issueCommentRequests)
          .where(and(eq(issueCommentRequests.id, request.id), eq(issueCommentRequests.companyId, request.companyId))).for("update");
        if (!owner) return;
        const completed = await tx.update(issueCommentRequestEffects).set({
          status: receipt ? "delivered" : "reconciliation_required", receipt, lastErrorCode: errorCode, updatedAt: now(),
        }).where(and(eq(issueCommentRequestEffects.id, effect.id), eq(issueCommentRequestEffects.generation, effect.generation),
          eq(issueCommentRequestEffects.status, "dispatching"))).returning();
        if (completed.length) await settleRequest(tx, request.id);
        return completed.length > 0;
      }).then(completed => {
        event(completed ? receipt ? effect.kind === "wake" ? "wake_admitted" : "effect_delivered" : "reconciliation_required" : "stale_claim_fenced",
          { companyId, requestId, effectId: effect.id, kind: effect.kind, generation: effect.generation, errorCode });
      });
      });
    },

    async status(input: { companyId: string; issueId: string; authorUserId: string; clientRequestId: string }) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(issueCommentRequests).where(and(
          eq(issueCommentRequests.companyId, input.companyId), eq(issueCommentRequests.issueId, input.issueId),
          eq(issueCommentRequests.authorUserId, input.authorUserId), eq(issueCommentRequests.clientRequestId, input.clientRequestId),
        ));
        if (!row) throw notFound("Comment request not found");
        if (!(await options.authorize(tx, row))) throw forbidden("Comment request is no longer authorized");
        const effects = await tx.select({ id: issueCommentRequestEffects.id, kind: issueCommentRequestEffects.kind,
          status: issueCommentRequestEffects.status, attempts: issueCommentRequestEffects.attemptCount,
          reason: issueCommentRequestEffects.lastErrorCode, lastAttemptAt: issueCommentRequestEffects.claimedAt,
        }).from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, row.id)).orderBy(asc(issueCommentRequestEffects.ordinal));
        return { id: row.id, protocolVersion: row.protocolVersion, commentId: row.commentId, status: row.status,
          reason: row.lastErrorCode, createdAt: row.createdAt, updatedAt: row.updatedAt, controls: controls(), effects };
      });
    },

    async pending(limit = 50) {
      return db.select({ id: issueCommentRequests.id, companyId: issueCommentRequests.companyId })
        .from(issueCommentRequests).where(sql`${issueCommentRequests.status} = 'pending' or exists (
          select 1 from issue_comment_request_effects e where e.request_id = ${issueCommentRequests.id}
          and (e.status = 'dispatching' or (e.status = 'reconciliation_required' and e.attempt_count < 8 and e.updated_at <= ${now().toISOString()}::timestamptz - interval '30 seconds') or (e.kind in ('workspace_cleanup', 'sandbox_cleanup') and e.status in ('pending', 'claimed')))
        )`)
        .orderBy(asc(issueCommentRequests.updatedAt), asc(issueCommentRequests.id)).limit(Math.max(1, Math.min(100, limit)));
    },
  };
}

/** Shared monotonic merge for acceptance and any future partial instance import.
 * Full snapshot restore deliberately restores the snapshot's own lineage. */
export async function raiseBoardCommentProtocolFloor(tx: Transaction, acceptedVersion: number) {
  if (!Number.isSafeInteger(acceptedVersion) || acceptedVersion < 0 || acceptedVersion > 2_147_483_647) throw new Error("Invalid Board comment protocol floor");
  await tx.insert(instanceSettings).values({ singletonKey: "default", minimumBoardCommentRequestProtocolVersion: acceptedVersion })
    .onConflictDoUpdate({ target: instanceSettings.singletonKey,
      set: { minimumBoardCommentRequestProtocolVersion: sql`greatest(${instanceSettings.minimumBoardCommentRequestProtocolVersion}, ${acceptedVersion})` } });
}

/** An unaware old handler can replay even completed requests incorrectly. */
export async function assertCommentRequestRollbackSafe(db: Db, targetProtocolVersion: number) {
  if (!Number.isSafeInteger(targetProtocolVersion) || targetProtocolVersion < 0) {
    throw new Error("Invalid rollback target Board comment protocol version");
  }
  const rows = await db.execute(sql`select to_regclass('public.issue_comment_requests') is not null as present,
    exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'instance_settings'
      and column_name = 'minimum_board_comment_request_protocol_version') as watermark_present`);
  if (rows.length !== 1 || typeof rows[0]?.present !== "boolean" || typeof rows[0]?.watermark_present !== "boolean") {
    throw new Error("Cannot establish Board comment protocol ledger presence");
  }
  if (!rows[0].present && !rows[0].watermark_present) return;
  if (!rows[0].present || !rows[0].watermark_present) throw new Error("Incomplete Board comment protocol schema");
  const watermark = await db.execute(sql`select minimum_board_comment_request_protocol_version as version
    from public.instance_settings where singleton_key = 'default'`);
  if (watermark.length !== 1 || !Number.isSafeInteger(watermark[0]?.version) || Number(watermark[0]?.version) < 0) {
    throw new Error("Cannot establish retained Board comment protocol watermark");
  }
  const compatibility = await db.execute(sql`select coalesce(max(protocol_version), 0) as version from public.issue_comment_requests`);
  if (compatibility.length !== 1 || !Number.isSafeInteger(compatibility[0]?.version) || Number(compatibility[0]?.version) < 0) {
    throw new Error("Cannot establish Board comment protocol rollback compatibility");
  }
  if (Math.max(Number(watermark[0].version), Number(compatibility[0].version)) > targetProtocolVersion) {
    throw new Error("Rollback target cannot safely process accepted Board comment requests");
  }
}

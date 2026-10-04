import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { lockBoardCommentEffectClaim } from "./board-comment-effect-claim.js";

export interface BoardCommentCancellationClaim { companyId: string; requestId: string; effectId: string; generation: number; kind: "interrupt" | "scheduled_retry_cancel" | "cancel_native_question_run" }

/**
 * Admit an immutable cancellation target before process/native control is touched.
 * This commits a durable stop intent, after which finishing stop cleanup is system
 * work even if the original author is subsequently revoked. An expired worker
 * cannot create a new stop intent with an obsolete generation.
 */
export async function admitBoardCommentCancellation(db: Db, runId: string, claim: BoardCommentCancellationClaim) {
  return db.transaction(async (tx) => {
    const { request, effect } = await lockBoardCommentEffectClaim(tx, { companyId: claim.companyId,
      requestId: claim.requestId, effectId: claim.effectId, generation: claim.generation, kind: claim.kind });
    if (!["interrupt", "scheduled_retry_cancel", "cancel_native_question_run"].includes(effect.kind)
        || effect.descriptor.targetRunId !== runId) throw conflict("Invalid accepted cancellation target");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, request.companyId))).for("update");
    if (!run) throw conflict("Accepted cancellation target is unavailable");
    const marker = { version: 1, requestId: request.id, effectId: effect.id, generation: effect.generation,
      clientRequestId: request.clientRequestId, commentId: request.commentId, issueId: request.issueId,
      authorUserId: request.authorUserId, responsibleUserId: request.responsibleUserId,
      targetRunId: run.id, acceptedAt: new Date().toISOString() };
    const prior = run.resultJson?.boardCommentCancellation;
    if (prior && typeof prior === "object") {
      if ((prior as Record<string, unknown>).effectId === effect.id) return prior as Record<string, unknown>;
      throw conflict("Cancellation target already has another accepted Board request");
    }
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ boardCommentCancellation: marker })}::jsonb` })
      .where(eq(heartbeatRuns.id, run.id));
    return marker;
  });
}

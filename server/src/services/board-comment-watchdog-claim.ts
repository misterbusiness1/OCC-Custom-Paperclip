import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issueCommentRequests, issueCommentRequestEffects, issueComments, issueWatchdogs, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { lockBoardCommentEffectClaim } from "./board-comment-effect-claim.js";
import { authorizeBoardCommentRequest } from "./board-comment-request-authority.js";

export interface BoardCommentWatchdogClaim { requestId: string; effectId: string; generation: number }
export interface BoardCommentWatchdogTarget { watchdogId: string; watchedIssueId: string; configurationSha256: string }
export function boardCommentWatchdogConfigurationSha256(row: typeof issueWatchdogs.$inferSelect) {
  return createHash("sha256").update(JSON.stringify([row.id, row.companyId, row.issueId, row.watchdogAgentId,
    row.instructions, row.status, row.createdAt.toISOString()])).digest("hex");
}

/** A stale worker may not begin another watchdog mutation or retarget a changed configuration. */
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function checkClaim(db: Db, claim: BoardCommentWatchdogClaim | undefined, watchdogId: string, lock: boolean) {
  if (!claim) return;
  if (lock) {
    const [identity] = await db.select({ companyId: issueCommentRequests.companyId }).from(issueCommentRequests)
      .where(eq(issueCommentRequests.id, claim.requestId));
    if (!identity) throw conflict("Watchdog request is unavailable");
    await lockBoardCommentEffectClaim(db as unknown as Transaction, { ...claim, companyId: identity.companyId, kind: "watchdog" });
  }
  const requestQuery = db.select().from(issueCommentRequests).where(eq(issueCommentRequests.id, claim.requestId));
  const [request] = await (lock ? requestQuery.for("update") : requestQuery);
  const effectQuery = db.select().from(issueCommentRequestEffects).where(and(
    eq(issueCommentRequestEffects.id, claim.effectId), eq(issueCommentRequestEffects.requestId, claim.requestId)));
  const [effect] = await (lock ? effectQuery.for("update") : effectQuery);
  if (!request || request.contentInvalidatedAt || !effect || effect.kind !== "watchdog"
    || effect.status !== "dispatching" || effect.generation !== claim.generation) throw conflict("Watchdog claim is no longer current");
  const targets = effect.descriptor.targets;
  const target = Array.isArray(targets) ? targets.find(t => t && typeof t === "object" && t.watchdogId === watchdogId) : null;
  const watchdogQuery = db.select().from(issueWatchdogs).where(and(eq(issueWatchdogs.id, watchdogId), eq(issueWatchdogs.companyId, request.companyId)));
  const [row] = await (lock ? watchdogQuery.for("update") : watchdogQuery);
  if (!row || !target || target.watchedIssueId !== row.issueId || target.configurationSha256 !== boardCommentWatchdogConfigurationSha256(row)) {
    throw conflict("Accepted watchdog configuration changed");
  }
  const commentQuery = db.select().from(issueComments).where(and(eq(issueComments.id, request.commentId), eq(issueComments.companyId, request.companyId)));
  const [comment] = await (lock ? commentQuery.for("update") : commentQuery);
  if (!comment || comment.deletedAt || comment.updatedAt.getTime() !== request.acceptedCommentUpdatedAt.getTime()) {
    throw conflict("Accepted watchdog comment changed");
  }
  const authorized = lock ? await authorizeBoardCommentRequest(db as unknown as Transaction, request)
    : await db.transaction(tx => authorizeBoardCommentRequest(tx, request));
  if (!authorized) throw conflict("Watchdog authority was revoked");
}

export async function assertBoardCommentWatchdogClaim(db: Db, claim: BoardCommentWatchdogClaim | undefined, watchdogId: string) {
  return checkClaim(db, claim, watchdogId, false);
}
/** Internal service transaction boundary, never a ledger-supplied executable callback. */
export async function withBoardCommentWatchdogMutation<T>(db: Db, claim: BoardCommentWatchdogClaim | undefined,
  watchdogId: string, mutate: (tx: Db) => Promise<T>): Promise<T> {
  if (!claim) return mutate(db);
  // Cross-target watchdog work may touch an ancestor/review issue after the
  // accepted source lock. PostgreSQL can abort that transaction for a deadlock.
  // Retry only a fully rolled-back DB mutation; callers defer all external work.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async tx => {
        await checkClaim(tx as unknown as Db, claim, watchdogId, true);
        return mutate(tx as unknown as Db);
      });
    } catch (error) {
      let cause: unknown = error;
      let deadlock = false;
      for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++) {
        if ("code" in cause && cause.code === "40P01") deadlock = true;
        cause = "cause" in cause ? cause.cause : undefined;
      }
      if (!deadlock || attempt >= 2) throw error;
    }
  }
}

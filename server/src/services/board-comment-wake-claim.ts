import { and, eq, inArray } from "drizzle-orm";
import { issueCommentRequests, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { lockBoardCommentEffectClaim } from "./board-comment-effect-claim.js";

export interface BoardCommentWakeClaim { requestId: string; effectId: string; generation: number }
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** The caller keeps these locks until its wake receipt and queue mutation commit. */
export async function assertBoardCommentWakeClaim(tx: Transaction, claim: BoardCommentWakeClaim,
  scope: { companyId: string; agentId: string; issueId: string | null; idempotencyKey?: string | null }) {
  const [identity] = await tx.select({ issueId: issueCommentRequests.issueId }).from(issueCommentRequests)
    .where(and(eq(issueCommentRequests.id, claim.requestId), eq(issueCommentRequests.companyId, scope.companyId)));
  if (!identity || !scope.issueId) throw conflict("Board wake issue identity is unavailable");
  await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, scope.companyId),
    inArray(issues.id, [...new Set([identity.issueId, scope.issueId])].sort()))).orderBy(issues.id).for("update");
  const { effect } = await lockBoardCommentEffectClaim(tx, { ...claim, companyId: scope.companyId, kind: "wake" });
  const payload = effect?.descriptor.wakeup && typeof effect.descriptor.wakeup === "object"
    ? (effect.descriptor.wakeup as Record<string, unknown>).payload as Record<string, unknown> | undefined : undefined;
  if (!effect || effect.kind !== "wake" || effect.status !== "dispatching" || effect.generation !== claim.generation
      || effect.descriptor.agentId !== scope.agentId || payload?.issueId !== scope.issueId || effect.idempotencyKey !== scope.idempotencyKey) {
    throw conflict("Board wake claim is no longer current");
  }
  return { id: effect.id, requestedAt: effect.createdAt };
}

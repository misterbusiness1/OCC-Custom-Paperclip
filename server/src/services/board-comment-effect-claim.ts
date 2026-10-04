import { and, eq } from "drizzle-orm";
import { issueCommentRequestEffects, issueCommentRequests, issueComments, issues, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../errors.js";
import { authorizeBoardCommentRequest } from "./board-comment-request-authority.js";
import { acceptedCommentDigest, canonicalCommentMaterial, resolveCommentAttachmentIdentities, type CommentRequestEnvelope } from "./issue-comment-request-canonical.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Locks the durable claim and governed material. Caller owns the transaction;
 * no network/filesystem work may run until it commits. */
export async function lockBoardCommentEffectClaim(tx: Transaction, claim: {
  companyId: string; requestId: string; effectId: string; generation: number; kind: string;
}) {
  const [identity] = await tx.select({ issueId: issueCommentRequests.issueId }).from(issueCommentRequests)
    .where(and(eq(issueCommentRequests.id, claim.requestId), eq(issueCommentRequests.companyId, claim.companyId)));
  if (identity) await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, identity.issueId), eq(issues.companyId, claim.companyId))).for("update");
  const [request] = await tx.select().from(issueCommentRequests).where(and(eq(issueCommentRequests.id, claim.requestId), eq(issueCommentRequests.companyId, claim.companyId))).for("update");
  const [effect] = await tx.select().from(issueCommentRequestEffects).where(and(eq(issueCommentRequestEffects.id, claim.effectId), eq(issueCommentRequestEffects.requestId, claim.requestId), eq(issueCommentRequestEffects.companyId, claim.companyId))).for("update");
  if (!request || !effect || effect.kind !== claim.kind || effect.status !== "dispatching" || effect.generation !== claim.generation) throw conflict("Accepted effect claim is no longer current");
  const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, request.commentId), eq(issueComments.companyId, request.companyId))).for("update");
  if (["workspace_cleanup", "sandbox_cleanup"].includes(effect.kind)) {
    // These handlers must separately prove ownership of the exact accepted
    // resource generation; the original author need not retain write access.
    return { request, effect, comment: comment ?? null, recoveryAuthority: "accepted_resource_cleanup" as const };
  }
  if (!comment || comment.deletedAt || request.contentInvalidatedAt || comment.updatedAt.getTime() !== request.acceptedCommentUpdatedAt.getTime()) throw conflict("Accepted comment is no longer executable");
  const envelope = request.canonicalEnvelope as unknown as CommentRequestEnvelope;
  if (acceptedCommentDigest(envelope, { body: comment.body, presentation: comment.presentation, metadata: comment.metadata }) !== request.payloadSha256) throw conflict("Accepted comment content changed");
  const attachments = await resolveCommentAttachmentIdentities(tx, { companyId: request.companyId, issueId: request.issueId,
    commentId: comment.id, attachmentIds: envelope.attachments.map((item) => item.attachmentId) });
  if (canonicalCommentMaterial(attachments) !== canonicalCommentMaterial(envelope.attachments)) throw conflict("Accepted attachments changed");
  if (!(await authorizeBoardCommentRequest(tx, request))) throw forbidden("Accepted effect authority was revoked");
  return { request, effect, comment, recoveryAuthority: "current_author" as const };
}

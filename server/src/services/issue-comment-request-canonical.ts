import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { assets, issueAttachments, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const BOARD_COMMENT_REQUEST_PROTOCOL_VERSION = 1;
export interface AcceptedAttachmentIdentity {
  attachmentId: string;
  assetId: string;
  sha256: string;
  byteSize: number;
}
export interface CommentRequestEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  authorUserId: string;
  responsibleUserId: string;
  authorization: { source: string; decision: string; policyVersion: 1 };
  normalization: { version: 1; censorUsername: boolean; profileSha256: string };
  interrupt: boolean;
  resume: boolean;
  reopen: boolean;
  authorType: "user";
  attachments: AcceptedAttachmentIdentity[];
}
export interface GovernedCommentMaterial {
  body: string;
  presentation: unknown;
  metadata: unknown;
}

export function canonicalCommentMaterial(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalCommentMaterial).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalCommentMaterial(entry)}`).join(",")}}`;
}
export function canonicalAcceptedComment(envelope: CommentRequestEnvelope, material: GovernedCommentMaterial): string {
  return canonicalCommentMaterial({ ...envelope, body: material.body, presentation: material.presentation ?? null, metadata: material.metadata ?? null });
}
export function acceptedCommentDigest(envelope: CommentRequestEnvelope, material: GovernedCommentMaterial): string {
  return createHash("sha256").update(canonicalAcceptedComment(envelope, material)).digest("hex");
}

/** A digest is only a fast rejection; full canonical equality is mandatory. */
export function assertSameAcceptedComment(
  expected: { envelope: CommentRequestEnvelope; material: GovernedCommentMaterial; digest: string },
  received: { envelope: CommentRequestEnvelope; material: GovernedCommentMaterial; digest: string },
) {
  if (expected.digest !== received.digest || canonicalAcceptedComment(expected.envelope, expected.material) !== canonicalAcceptedComment(received.envelope, received.material)) {
    throw conflict("Message request ID was already used for different content", { code: "comment_request_conflict" });
  }
}

/** Lock and authorize integrity rows; order follows the first occurrence in the request. */
export async function resolveCommentAttachmentIdentities(tx: Transaction, input: {
  companyId: string; issueId: string; attachmentIds: string[]; commentId?: string;
}): Promise<AcceptedAttachmentIdentity[]> {
  const ids = [...new Set(input.attachmentIds)];
  if (!ids.length) return [];
  // Stable database lock order avoids deadlocks for overlapping ordered inputs.
  const rows = await tx.select({ attachment: issueAttachments, asset: assets })
    .from(issueAttachments).innerJoin(assets, eq(assets.id, issueAttachments.assetId))
    .where(and(eq(issueAttachments.companyId, input.companyId), eq(issueAttachments.issueId, input.issueId),
      eq(assets.companyId, input.companyId), inArray(issueAttachments.id, [...ids].sort())))
    .orderBy(issueAttachments.id).for("update");
  const byId = new Map(rows.map((row) => [row.attachment.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row || (row.attachment.issueCommentId !== null && row.attachment.issueCommentId !== input.commentId)) {
      throw conflict("Attachment is outside this accepted comment", { code: "comment_request_attachment_conflict" });
    }
    if (!/^[a-f0-9]{64}$/i.test(row.asset.sha256) || row.asset.byteSize < 0) {
      throw conflict("Attachment integrity evidence is invalid", { code: "comment_request_attachment_integrity_invalid" });
    }
    return { attachmentId: row.attachment.id, assetId: row.asset.id, sha256: row.asset.sha256.toLowerCase(), byteSize: row.asset.byteSize };
  });
}

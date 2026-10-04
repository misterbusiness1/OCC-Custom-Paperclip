import { describe, expect, it } from "vitest";
import { acceptedCommentDigest, assertSameAcceptedComment, type CommentRequestEnvelope } from "../services/issue-comment-request-canonical.js";
const envelope: CommentRequestEnvelope = {
  version: 1, companyId: "company", issueId: "issue", authorUserId: "board", responsibleUserId: "board",
  authorization: { source: "session", decision: "company_operator", policyVersion: 1 },
  normalization: { version: 1, censorUsername: false, profileSha256: "fixture" },
  interrupt: true, resume: false, reopen: false, authorType: "user", attachments: [],
};
const material = { body: "exact original", presentation: null, metadata: null };
describe("accepted Board comment canonical equality", () => {
  it("rejects different material even if digests collide", () => {
    expect(() => assertSameAcceptedComment({ envelope, material, digest: "forced-collision" },
      { envelope, material: { ...material, body: "different" }, digest: "forced-collision" })).toThrow("different content");
  });
  it.each(["companyId", "issueId", "authorUserId", "responsibleUserId"])("binds %s even under a digest collision", (field) => {
    expect(() => assertSameAcceptedComment({ envelope, material, digest: "forced-collision" },
      { envelope: { ...envelope, [field]: "different" }, material, digest: "forced-collision" })).toThrow("different content");
  });
  it("treats attachment order and integrity as semantic", () => {
    const a = { attachmentId: "a", assetId: "aa", sha256: "a".repeat(64), byteSize: 10 };
    const b = { attachmentId: "b", assetId: "bb", sha256: "b".repeat(64), byteSize: 20 };
    expect(acceptedCommentDigest({ ...envelope, attachments: [a, b] }, material)).not.toBe(acceptedCommentDigest({ ...envelope, attachments: [b, a] }, material));
    expect(acceptedCommentDigest({ ...envelope, attachments: [a] }, material)).not.toBe(acceptedCommentDigest({ ...envelope, attachments: [{ ...a, byteSize: 11 }] }, material));
  });
  it("ignores object property insertion order only", () => {
    const digest = acceptedCommentDigest(envelope, material);
    expect(() => assertSameAcceptedComment({ envelope, material, digest }, { envelope: { ...envelope }, material: { metadata: null, presentation: null, body: material.body }, digest })).not.toThrow();
  });
});

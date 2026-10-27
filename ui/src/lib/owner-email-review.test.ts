import { describe, expect, it } from "vitest";
import { ownerEmailReviewUrl } from "./owner-email-review";

const approval = { id: "approval", companyId: "company", status: "approved" as const, requestedByAgentId: "agent", payload: { channel: "email reply" } };
const config = { origin: "https://owner.example.test", companyId: "company", requesterIds: "agent" };
const app = "https://app.example.test";

describe("owner email review navigation", () => {
  it("passes only the card ID to the configured owner origin", () => {
    expect(ownerEmailReviewUrl(approval, config, app)).toBe("https://owner.example.test/?approvalId=approval");
  });
  it("does not offer authorization for other companies, callers, or undecided cards", () => {
    for (const change of [{ companyId: "other" }, { requestedByAgentId: "other" }, { status: "pending" as const }, { payload: { channel: "slack" } }]) {
      expect(ownerEmailReviewUrl({ ...approval, ...change }, config, app)).toBeNull();
    }
    expect(ownerEmailReviewUrl(approval, {}, app)).toBeNull();
  });
  it("rejects unsafe or ambiguous owner destinations", () => {
    for (const origin of [app, "https://app.example.test:3443", "http://owner.example.test", "javascript:alert(1)", "https://user:secret@owner.example.test", "https://owner.example.test/other", "https://owner.example.test/?next=other", "https://owner.example.test/#other"]) {
      expect(ownerEmailReviewUrl(approval, { ...config, origin }, app)).toBeNull();
    }
  });
});

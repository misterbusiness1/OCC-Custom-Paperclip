import { describe, expect, it } from "vitest";
import { buildHydratedApprovalDetail } from "./approval-hydration.js";
import { approvalDetailV2Schema } from "./validators/approval.js";
import type { Approval } from "./types/approval.js";

function baseApproval(overrides: Partial<Approval>): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("buildHydratedApprovalDetail", () => {
  it("produces a non-empty sideEffects preview and refund detail for gate_a refund payloads", () => {
    const approval = baseApproval({
      payload: {
        gate: "gate_a",
        orderId: "1001",
        customerId: "2002",
        amountUsd: 42.5,
        currency: "USD",
        actionType: "refund_full",
        reason: "Customer requested a full refund before fulfillment.",
      },
    });

    const detail = buildHydratedApprovalDetail(approval);

    expect(detail.version).toBe(2);
    expect(detail.sideEffects.length).toBeGreaterThan(0);
    expect(detail.sideEffects[0]?.detail).toContain("1001");
    expect(detail.refund).toMatchObject({
      orderId: "1001",
      customerId: "2002",
      amountUsd: 42.5,
      actionType: "refund_full",
    });
    expect(detail.reply).toBeNull();
    expect(detail).not.toHaveProperty("payload");
    expect(detail).not.toHaveProperty("rawPayload");

    expect(() => approvalDetailV2Schema.parse(detail)).not.toThrow();
  });

  it("produces a non-empty sideEffects preview for gate_a non-refund_full action types (store_credit)", () => {
    const approval = baseApproval({
      payload: {
        gate: "gate_a",
        orderId: "1001",
        customerId: "2002",
        amountUsd: 15,
        actionType: "store_credit",
        reason: "Goodwill gesture.",
      },
    });

    const detail = buildHydratedApprovalDetail(approval);
    expect(detail.sideEffects.length).toBeGreaterThan(0);
    expect(detail.sideEffects[0]?.label).toBe("Store credit issued");
  });

  it("preserves recipient address plus original/proposed message context for gate_b reply payloads without exposing raw payload by default", () => {
    const approval = baseApproval({
      payload: {
        gate: "gate_b",
        recipient: "customer@example.com",
        channel: "email",
        subject: "Your order update",
        body: "Here is the proposed reply to send.",
        originalMessage: "Hi, where is my order?",
        threadOrOrderRef: "ticket-1001",
      },
    });

    const detail = buildHydratedApprovalDetail(approval);

    expect(detail.sideEffects.length).toBeGreaterThan(0);
    expect(detail.refund).toBeNull();
    expect(detail.reply).toEqual({
      recipient: "customer@example.com",
      channel: "email",
      subject: "Your order update",
      proposedMessage: "Here is the proposed reply to send.",
      originalMessage: "Hi, where is my order?",
    });
    expect(detail).not.toHaveProperty("rawPayload");

    expect(() => approvalDetailV2Schema.parse(detail)).not.toThrow();
  });

  it("defaults originalMessage to null when the reply payload omits it", () => {
    const approval = baseApproval({
      payload: {
        gate: "gate_b",
        recipient: "customer@example.com",
        channel: "email",
        subject: "Your order update",
        body: "Here is the proposed reply to send.",
        threadOrOrderRef: "ticket-1001",
      },
    });

    const detail = buildHydratedApprovalDetail(approval);
    expect(detail.reply?.originalMessage).toBeNull();
  });

  it("still synthesizes side effects for hire_agent approvals (not the only type covered)", () => {
    const approval = baseApproval({
      type: "hire_agent",
      payload: { name: "New Agent", role: "support", budgetMonthlyCents: 5000 },
    });

    const detail = buildHydratedApprovalDetail(approval);
    expect(detail.sideEffects.length).toBeGreaterThan(0);
    expect(detail.refund).toBeNull();
    expect(detail.reply).toBeNull();
  });

  it("includes rawPayload only when explicitly requested", () => {
    const approval = baseApproval({
      payload: { gate: "gate_a", orderId: "1", customerId: "2", amountUsd: 1, actionType: "refund_full", reason: "x" },
    });

    const withRaw = buildHydratedApprovalDetail(approval, { includeRawPayload: true });
    expect(withRaw.rawPayload).toEqual(approval.payload);
  });
});

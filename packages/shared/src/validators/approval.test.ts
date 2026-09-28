import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  approvalDetailV2Schema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

const validGateAPayload = {
  gate: "gate_a",
  orderId: "1001",
  customerId: "2002",
  amountUsd: 42.5,
  actionType: "refund_full",
  currency: "USD",
  wooCommerceTransactionRef: "wc-order-1001:txn-2002",
  reason: "Customer requested a full refund before fulfillment.",
};

const validGateBPayload = {
  gate: "gate_b",
  recipient: "customer@example.com",
  channel: "email",
  subject: "Your order update",
  contentType: "text/plain",
  body: "Send the approved customer response.",
  bodyHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  threadOrOrderRef: "ticket-1001",
  threadRef: {
    ticketId: "ticket-1001",
    orderRef: "order-2002",
  },
  priority: "high",
  slaDeadline: "2026-08-04T12:00:00.000Z",
  contextPulled: {
    at: "2026-08-03T12:00:00.000Z",
    sources: ["gmail:thread-1001"],
  },
  risks: [
    {
      code: "customer_confusion",
      description: "Customer may need clarification about refund timing.",
    },
  ],
};

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body).toBe(
      "Looks good\n\nApproved.",
    );
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote).toBe(
      "Decision\n\nApproved.",
    );
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body).toBe(
      "Looks good\n\nApproved.",
    );
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote).toBe(
      "Decision\n\nApproved.",
    );
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote).toBe(
      "Decision\nRevise.",
    );
  });

  it("accepts representative Gate A board approval payloads", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      requestedByAgentId: "00000000-0000-0000-0000-000000000001",
      payload: validGateAPayload,
    });

    expect(parsed.type).toBe("request_board_approval");
    expect(parsed.payload).toMatchObject({ gate: "gate_a" });
  });

  it("rejects malformed Gate A board approval payloads with field-specific errors", () => {
    const result = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: {
        ...validGateAPayload,
        actionType: "invalid_action",
        currency: "usd",
        wooCommerceTransactionRef: "",
        orderId: "",
        customerId: "",
        amountUsd: -1,
        reason: "",
      },
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["payload", "actionType"] }),
        expect.objectContaining({ path: ["payload", "orderId"] }),
        expect.objectContaining({ path: ["payload", "customerId"] }),
        expect.objectContaining({ path: ["payload", "amountUsd"] }),
        expect.objectContaining({ path: ["payload", "currency"] }),
        expect.objectContaining({ path: ["payload", "wooCommerceTransactionRef"] }),
        expect.objectContaining({ path: ["payload", "reason"] }),
      ]),
    );
  });

  it("accepts representative Gate B board approval payloads", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      payload: validGateBPayload,
    });

    expect(parsed.type).toBe("request_board_approval");
    expect(parsed.payload).toMatchObject({ gate: "gate_b" });
  });

  it("rejects email Gate B payloads without the exact required subject", () => {
    const { subject: _subject, ...payload } = validGateBPayload;
    const result = createApprovalSchema.safeParse({ type: "request_board_approval", payload });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["payload", "subject"] })]),
    );
  });

  it("accepts strict generic board-decision payloads", () => {
    const result = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: {
        title: "Approve monthly hosting spend",
        summary: "Estimated cost is $42/month for provider X.",
        recommendedAction: "Approve provider X and continue setup.",
        reasoning: "Provider X meets the requirements at the quoted monthly cost.",
        pros: ["Setup can continue with a bounded monthly commitment."],
        risks: ["Costs may increase with usage."],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects incomplete generic request_board_approval payloads", () => {
    const result = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: { title: "Approve something" },
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["payload", "summary"] }),
        expect.objectContaining({ path: ["payload", "recommendedAction"] }),
        expect.objectContaining({ path: ["payload", "risks"] }),
      ]),
    );
  });

  it("accepts Gate B payloads carrying an optional originalMessage field", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      payload: { ...validGateBPayload, originalMessage: "Hi, where is my order?" },
    });

    expect(parsed.payload).toMatchObject({ originalMessage: "Hi, where is my order?" });
  });

  it("contract-checks a well-formed v2 hydrated refund detail envelope", () => {
    const result = approvalDetailV2Schema.safeParse({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      version: 2,
      summary: "Refund request: refund_full of $42.50 on order 1001",
      sideEffects: [{ label: "Refund issued", detail: "$42.50 refund issued for customer 2002 on order 1001" }],
      refund: {
        orderId: "1001",
        customerId: "2002",
        amountUsd: 42.5,
        currency: "USD",
        actionType: "refund_full",
        reasonCode: null,
        reason: "Customer requested a full refund before fulfillment.",
      },
      reply: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects a v2 hydrated refund detail missing required fields", () => {
    const result = approvalDetailV2Schema.safeParse({
      version: 2,
      summary: "Refund request",
      sideEffects: [],
      refund: { orderId: "1001" },
      reply: null,
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown fields on generic board-decision payloads", () => {
    const result = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: {
        title: "Approve something",
        summary: "A bounded decision is needed.",
        recommendedAction: "Approve it.",
        risks: ["The decision may need revisiting."],
        arbitrary: true,
      },
    });

    expect(result.success).toBe(false);
  });
});

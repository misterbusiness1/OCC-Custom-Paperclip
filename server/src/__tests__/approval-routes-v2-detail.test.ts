import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  createWithIdempotency: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /api/approvals/:id v2 hydrated contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
  });

  it("returns the legacy approval object without ?v=2", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: { name: "New Agent", role: "support" },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await request(await createApp()).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(res.body.payload).toEqual({ name: "New Agent", role: "support" });
    expect(res.body.version).toBeUndefined();
  });

  it("returns a hydrated v2 envelope for a refund (gate_a) approval with ?v=2", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {
        gate: "gate_a",
        orderId: "1001",
        customerId: "2002",
        amountUsd: 42.5,
        currency: "USD",
        actionType: "refund_full",
        reason: "Customer requested a full refund before fulfillment.",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await request(await createApp()).get("/api/approvals/approval-2?v=2");

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.payload).toBeUndefined();
    expect(res.body.sideEffects.length).toBeGreaterThan(0);
    expect(res.body.refund).toMatchObject({ orderId: "1001", customerId: "2002", actionType: "refund_full" });
    expect(res.body.reply).toBeNull();
  });

  it("returns a hydrated v2 envelope for a reply (gate_b) approval preserving recipient and message context", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {
        gate: "gate_b",
        recipient: "customer@example.com",
        channel: "email",
        subject: "Your order update",
        body: "Here is the proposed reply.",
        originalMessage: "Hi, where is my order?",
        threadOrOrderRef: "ticket-1001",
      },
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await request(await createApp()).get("/api/approvals/approval-3?v=2");

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.reply).toEqual({
      recipient: "customer@example.com",
      channel: "email",
      subject: "Your order update",
      proposedMessage: "Here is the proposed reply.",
      originalMessage: "Hi, where is my order?",
    });
    expect(res.body.refund).toBeNull();
  });
});

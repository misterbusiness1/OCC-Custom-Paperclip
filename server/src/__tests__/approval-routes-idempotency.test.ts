import { createHash } from "node:crypto";
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

async function createApp(actorOverrides: Record<string, unknown> = {}) {
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
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1", agentId = "agent-1") {
  const runRows = [{
    id: runId,
    companyId: "company-1",
    agentId,
    contextSnapshot,
  }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(
            Object.keys(selection).includes("contextSnapshot") ? runRows : [],
          ),
        })),
      })),
    })),
  } as any;
}

async function createAgentApp(options: { runId?: string; contextSnapshot?: Record<string, unknown> } = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: options.runId ?? "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(options.contextSnapshot, options.runId ?? "run-1")));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.createWithIdempotency.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("derives approval attribution from the authenticated actor on approve", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-4",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-4",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-4/approve")
      .send({ decidedByUserId: "forged-user", decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-4", "user-1", "ship it");
  });

  it("derives approval attribution from the authenticated actor on reject", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-5",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-5",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-5/reject")
      .send({ decidedByUserId: "forged-user", decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-5", "user-1", "not now");
  });

  it("derives approval attribution from the authenticated actor on request revision", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "revision_requested",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-6/request-revision")
      .send({ decidedByUserId: "forged-user", decisionNote: "Need changes" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      "approval-6",
      "user-1",
      "Need changes",
    );
  });

  it("lets agents create Gate A issue-linked board approval requests", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        gate: "gate_a",
        orderId: "1001",
        customerId: "2002",
        amountUsd: 42.5,
        actionType: "refund_full",
        currency: "USD",
        wooCommerceTransactionRef: "wc-order-1001:txn-2002",
        reason: "Customer requested a full refund before fulfillment.",
        requestedByAgentId: "agent-1",
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: {
          gate: "gate_a",
          orderId: "1001",
          customerId: "2002",
          amountUsd: 42.5,
          actionType: "refund_full",
          currency: "USD",
          wooCommerceTransactionRef: "wc-order-1001:txn-2002",
          reason: "Customer requested a full refund before fulfillment.",
        },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
    });
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({ requestedByAgentId: "agent-1" }),
        requestedByAgentId: "agent-1",
      }),
    );
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
      }),
    );
  });

  it("accepts the generic board approval payload documented by the bundled skill", async () => {
    const payload = {
      title: "Approve monthly hosting spend",
      summary: "Estimated cost is $42/month for provider X.",
      recommendedAction: "Approve provider X and continue setup.",
      reasoning: "Provider X meets the requirements at the quoted monthly cost.",
      pros: ["Setup can continue with a bounded $42 monthly commitment."],
      risks: ["Costs may increase with usage."],
    };
    mockApprovalService.create.mockResolvedValue({
      id: "approval-generic",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { ...payload, requestedByAgentId: "agent-1" },
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: { ...payload, requestedByAgentId: "agent-1" },
        requestedByAgentId: "agent-1",
      }),
    );
  });

  it("blocks status-only recovery runs from creating approvals", async () => {
    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          gate: "gate_a",
          orderId: "1001",
          customerId: "2002",
          amountUsd: 42.5,
          actionType: "refund_full",
          reason: "Customer requested a refund.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from resubmitting approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-7/resubmit")
      .send({ payload: { title: "Retry" } });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from commenting on approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-8",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-8/comments")
      .send({ body: "please approve" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
  });

  it("rejects malformed Gate A creation with field-specific 4xx errors", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          gate: "gate_a",
          orderId: "",
          customerId: "",
          amountUsd: -1,
          actionType: "invalid_action",
          currency: "usd",
          wooCommerceTransactionRef: "",
          reason: "",
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["payload", "actionType"] }),
        expect.objectContaining({ path: ["payload", "currency"] }),
        expect.objectContaining({ path: ["payload", "wooCommerceTransactionRef"] }),
        expect.objectContaining({ path: ["payload", "reason"] }),
      ]),
    );
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("lets agents create Gate B approval requests when bodyHash matches body", async () => {
    const body = "Send the customer this approved response.";
    const bodyHash = `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
    mockApprovalService.create.mockResolvedValue({
      id: "approval-gate-b",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        gate: "gate_b",
        recipient: "customer@example.com",
        channel: "email",
        subject: "Your order update",
        contentType: "text/plain",
        body,
        bodyHash,
        threadOrOrderRef: "gmail-thread-1",
        threadRef: { ticketId: "gmail-thread-1", orderRef: "order-1001" },
        priority: "high",
        slaDeadline: "2026-08-04T12:00:00.000Z",
        contextPulled: { at: "2026-08-03T12:00:00.000Z", sources: ["gmail:thread-1001"] },
        risks: [{ code: "customer_confusion", description: "Customer may need clarification." }],
        requestedByAgentId: "agent-1",
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          gate: "gate_b",
          recipient: "customer@example.com",
          channel: "email",
          subject: "Your order update",
          contentType: "text/plain",
          body,
          bodyHash,
          threadOrOrderRef: "gmail-thread-1",
          threadRef: { ticketId: "gmail-thread-1", orderRef: "order-1001" },
          priority: "high",
          slaDeadline: "2026-08-04T12:00:00.000Z",
          contextPulled: { at: "2026-08-03T12:00:00.000Z", sources: ["gmail:thread-1001"] },
          risks: [{ code: "customer_confusion", description: "Customer may need clarification." }],
        },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ payload: expect.objectContaining({ bodyHash }) }),
    );
  });

  it("lets agents create Gate B approval requests without optional bodyHash", async () => {
    const body = "Send the customer this approved response.";
    mockApprovalService.create.mockImplementation(async (_companyId, approval) => ({
      id: "approval-gate-b-without-hash",
      companyId: "company-1",
      ...approval,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
    }));

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          gate: "gate_b",
          recipient: "customer@example.com",
          channel: "email",
          subject: "Your order update",
          body,
          threadOrOrderRef: "gmail-thread-1",
        },
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          gate: "gate_b",
          body,
          requestedByAgentId: "agent-1",
        }),
      }),
    );
    expect(mockApprovalService.create.mock.calls[0]?.[1].payload).not.toHaveProperty("bodyHash");
  });

  it("rejects Gate B approval requests when bodyHash does not match body", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          gate: "gate_b",
          recipient: "customer@example.com",
          channel: "email",
          subject: "Your order update",
          contentType: "text/plain",
          body: "Send one response.",
          bodyHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          threadOrOrderRef: "gmail-thread-1",
          threadRef: { ticketId: "gmail-thread-1", orderRef: "order-1001" },
          priority: "high",
          slaDeadline: "2026-08-04T12:00:00.000Z",
          contextPulled: { at: "2026-08-03T12:00:00.000Z", sources: ["gmail:thread-1001"] },
          risks: [{ code: "customer_confusion", description: "Customer may need clarification." }],
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["payload", "bodyHash"] })]),
    );
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("returns the first approval without duplicate side effects on exact idempotent replay", async () => {
    mockApprovalService.createWithIdempotency.mockResolvedValue({
      replayed: true,
      approval: {
        id: "approval-replay",
        companyId: "company-1",
        type: "request_board_approval",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        status: "pending",
        payload: {
          gate: "gate_a",
          orderId: "1001",
          customerId: "2002",
          amountUsd: 42.5,
          actionType: "refund_full",
          currency: "USD",
          wooCommerceTransactionRef: "wc-order-1001:txn-2002",
          reason: "Customer requested a full refund before fulfillment.",
          requestedByAgentId: "agent-1",
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        createdAt: new Date("2026-04-06T00:00:00.000Z"),
        updatedAt: new Date("2026-04-06T00:00:00.000Z"),
      },
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .set("Idempotency-Key", "approval:OXFA-2794")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: {
          gate: "gate_a",
          orderId: "1001",
          customerId: "2002",
          amountUsd: 42.5,
          actionType: "refund_full",
          currency: "USD",
          wooCommerceTransactionRef: "wc-order-1001:txn-2002",
          reason: "Customer requested a full refund before fulfillment.",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("approval-replay");
    expect(mockApprovalService.createWithIdempotency).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ type: "request_board_approval" }),
      "approval:OXFA-2794",
      ["00000000-0000-0000-0000-000000000001"],
    );
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-replay",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

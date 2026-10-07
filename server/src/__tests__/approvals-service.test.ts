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

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";

function createApproval(status: string): ApprovalRecord {
  return {
    id: APPROVAL_ID,
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
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
    set,
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
    const result = await svc.approve(APPROVAL_ID, "board", "ship it");

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
    const result = await svc.reject(APPROVAL_ID, "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve(APPROVAL_ID, "board", "ship it");

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
    const result = await svc.approve(APPROVAL_ID, "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: approved.payload.adapterConfig,
      }),
    );
  });

  it("rejects malformed approval ids before querying Postgres", async () => {
    const dbStub = createDbStub([], []);
    const svc = approvalService(dbStub.db as any);

    await expect(svc.approve("not-a-uuid", "board")).rejects.toMatchObject({ status: 404 });
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
    expect(dbStub.db.select).not.toHaveBeenCalled();
  });
});

describe("approvalService.resubmit", () => {
  it("keeps the board's change request on the resubmitted approval", async () => {
    const sentBack = { ...createApproval("revision_requested"), decisionNote: "Quote the delivery date." };
    const dbStub = createDbStub([[sentBack]], [{ ...sentBack, status: "pending" }]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.resubmit(APPROVAL_ID, { agentId: "agent-2" });

    expect(result.status).toBe("pending");
    expect(dbStub.set).toHaveBeenCalledTimes(1);
    const written = dbStub.set.mock.calls[0]![0] as Record<string, unknown>;
    // The note is not written at all, so the stored change request stays.
    expect(Object.keys(written)).not.toContain("decisionNote");
    expect(written).toMatchObject({
      status: "pending",
      payload: { agentId: "agent-2" },
      decidedByUserId: null,
      decidedAt: null,
    });
    expect(written.updatedAt).toBeInstanceOf(Date);
  });

  it("refuses an approval that is not sent back, without writing", async () => {
    const dbStub = createDbStub([[createApproval("pending")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.resubmit(APPROVAL_ID)).rejects.toMatchObject({ status: 422 });
    expect(dbStub.set).not.toHaveBeenCalled();
  });

  it("refuses when the approval left revision_requested between the read and the write", async () => {
    // The read sees it sent back; the guarded write then matches no row.
    const dbStub = createDbStub([[createApproval("revision_requested")]], []);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.resubmit(APPROVAL_ID)).rejects.toMatchObject({
      status: 422,
      message: "Only revision requested approvals can be resubmitted",
    });
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

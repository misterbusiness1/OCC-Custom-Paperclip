import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQL } from "drizzle-orm";
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

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  })),
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

  const insertValues = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  const db: Record<string, unknown> = { select, update, insert };
  // The stub has one connection: a transaction runs its callback on it.
  db.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(db));

  return {
    db,
    selectWhere,
    returning,
    set,
    insertValues,
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

describe("approvalService expected version", () => {
  const SHOWN = new Date("2026-10-07T12:34:56.789Z");
  const LATER = new Date("2026-10-07T12:40:00.000Z");
  const at = (status: string, updatedAt: Date) => ({ ...createApproval(status), type: "request_board_approval", updatedAt });
  const conflictWith = (currentStatus: string) => ({
    status: 409,
    message: "This request changed after you opened it. Reload it and decide again.",
    details: {
      code: "approval_version_conflict",
      currentStatus,
      currentUpdatedAt: LATER.toISOString(),
      expectedUpdatedAt: SHOWN.toISOString(),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses approve, reject and request-revision without writing when the approval changed", async () => {
    for (const decide of ["approve", "reject", "requestRevision"] as const) {
      const dbStub = createDbStub([[at("pending", LATER)]], []);
      const svc = approvalService(dbStub.db as any);

      await expect(svc[decide](APPROVAL_ID, "board", "note", { expectedUpdatedAt: SHOWN }))
        .rejects.toMatchObject(conflictWith("pending"));
      expect(dbStub.set).not.toHaveBeenCalled();
    }
  });

  it("answers the conflict, not the idempotent no-op, for an approval decided elsewhere", async () => {
    const dbStub = createDbStub([[at("approved", LATER)]], []);
    const svc = approvalService(dbStub.db as any);

    await expect(svc.approve(APPROVAL_ID, "board", "note", { expectedUpdatedAt: SHOWN }))
      .rejects.toMatchObject(conflictWith("approved"));
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
  });

  it("answers the conflict when the guarded write matches no row because the approval changed in between", async () => {
    for (const decide of ["approve", "reject", "requestRevision"] as const) {
      // Read: the version shown. Write: no row. Read again: changed.
      const dbStub = createDbStub([[at("pending", SHOWN)], [at("pending", LATER)]], []);
      const svc = approvalService(dbStub.db as any);

      await expect(svc[decide](APPROVAL_ID, "board", "note", { expectedUpdatedAt: SHOWN }))
        .rejects.toMatchObject(conflictWith("pending"));
    }
  });

  it("stores the decision when the version is the one shown", async () => {
    const dbStub = createDbStub([[at("pending", SHOWN)]], [at("approved", LATER)]);
    const svc = approvalService(dbStub.db as any);

    const result = await svc.approve(APPROVAL_ID, "board", "note", { expectedUpdatedAt: new Date(SHOWN.getTime()) });

    expect(result.applied).toBe(true);
    expect(dbStub.set).toHaveBeenCalledTimes(1);
  });

  it("decides as before when no version is given, whatever the approval's updatedAt", async () => {
    const dbStub = createDbStub([[at("pending", LATER)]], [at("approved", LATER)]);
    const svc = approvalService(dbStub.db as any);

    await expect(svc.approve(APPROVAL_ID, "board", "note")).resolves.toMatchObject({ applied: true });
    // And the old no-op for a request already in the target status.
    const decided = createDbStub([[at("approved", LATER)]], []);
    await expect(approvalService(decided.db as any).approve(APPROVAL_ID, "board")).resolves.toMatchObject({ applied: false });
  });

  it("refuses request-revision with 422 when the write matches no row and no version was given", async () => {
    const dbStub = createDbStub([[at("pending", SHOWN)], [at("approved", LATER)]], []);
    const svc = approvalService(dbStub.db as any);

    await expect(svc.requestRevision(APPROVAL_ID, "board", "note")).rejects.toMatchObject({
      status: 422,
      message: "Only pending approvals can request revision",
    });
  });
});

describe("approvalService.requestRevision change-request comment", () => {
  const sentBack = { ...createApproval("revision_requested"), type: "request_board_approval" };

  it("writes the note as a board comment in the transaction that sends the request back", async () => {
    const dbStub = createDbStub([[createApproval("pending")]], [sentBack]);
    const svc = approvalService(dbStub.db as any);

    await svc.requestRevision(APPROVAL_ID, "board-user-1", "1. Quote the date.\n2. Name the price.");

    expect(dbStub.db.transaction).toHaveBeenCalledTimes(1);
    expect(dbStub.insertValues).toHaveBeenCalledTimes(1);
    expect(dbStub.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      approvalId: APPROVAL_ID,
      authorAgentId: null,
      authorUserId: "board-user-1",
      body: "Changes requested:\n\n1. Quote the date.\n2. Name the price.",
    }));
  });

  it("writes no comment when there is no note", async () => {
    for (const note of [undefined, null, "", "  \n "]) {
      const dbStub = createDbStub([[createApproval("pending")]], [sentBack]);
      await approvalService(dbStub.db as any).requestRevision(APPROVAL_ID, "board-user-1", note);
      expect(dbStub.insertValues).not.toHaveBeenCalled();
    }
  });

  it("writes no comment when the request is refused", async () => {
    // Not pending at the read.
    const refusedAtRead = createDbStub([[sentBack]], []);
    await expect(approvalService(refusedAtRead.db as any).requestRevision(APPROVAL_ID, "board-user-1", "again"))
      .rejects.toMatchObject({ status: 422 });
    expect(refusedAtRead.insertValues).not.toHaveBeenCalled();

    // Pending at the read, changed before the write.
    const refusedAtWrite = createDbStub([[createApproval("pending")], [sentBack]], []);
    await expect(approvalService(refusedAtWrite.db as any).requestRevision(APPROVAL_ID, "board-user-1", "again"))
      .rejects.toMatchObject({ status: 422 });
    expect(refusedAtWrite.insertValues).not.toHaveBeenCalled();
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
    // Not the clock's time as it is: an expression the database evaluates, so the
    // new version is later than the stored one (see approval-version-guard.test.ts).
    expect(written.updatedAt).toBeInstanceOf(SQL);
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

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentApiKeys,
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  companySecrets,
  companySecretBindings,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";

const mockNotifyHireApproved = vi.hoisted(() => vi.fn(async (_db: ReturnType<typeof createDb>, _input: unknown) => {}));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved: mockNotifyHireApproved }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockNotifyHireApproved.mockReset();
    await db.delete(companySecretBindings);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });
  async function seedAgent(
    companyId: string,
    overrides: Partial<Parameters<ReturnType<typeof agentService>["create"]>[1]> = {},
  ) {
    return agentService(db).create(companyId, {
      name: `Agent ${randomUUID().slice(0, 8)}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
      ...overrides,
    });
  }

  async function seedHireApproval(
    companyId: string,
    payload: Record<string, unknown>,
    overrides: Partial<Parameters<ReturnType<typeof approvalService>["create"]>[1]> = {},
  ) {
    return approvalService(db).create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
      ...overrides,
    });
  }

  it("resolves the oldest open hire approval when several name the same agent", async () => {
    const companyId = await seedCompany();
    const pending = await seedAgent(companyId, { status: "pending_approval" });
    // Insert the newer approval first so physical row order disagrees with age.
    await seedHireApproval(
      companyId,
      { agentId: pending.id, adapterConfig: { command: "echo injected" } },
      { createdAt: new Date("2026-10-31T12:00:00.000Z") },
    );
    const original = await seedHireApproval(
      companyId,
      { agentId: pending.id, adapterConfig: { command: "echo reviewed" } },
      { createdAt: new Date("2026-10-30T12:00:00.000Z") },
    );

    const found = await approvalService(db).findOpenHireApprovalForAgent(companyId, pending.id);

    expect(found?.id).toBe(original.id);
  });

  it("rolls back an approval whose config references another company's secret", async () => {
    const companyId = await seedCompany();
    const foreignCompanyId = await seedCompany();
    const pending = await seedAgent(companyId, { status: "pending_approval" });
    const [secret] = await db.insert(companySecrets).values({
      companyId: foreignCompanyId, key: "FOREIGN_FIXTURE", name: "Foreign fixture", provider: "local_encrypted",
    }).returning();
    const approval = await seedHireApproval(companyId, {
      agentId: pending.id, name: pending.name, budgetMonthlyCents: 1234,
      adapterConfig: { env: { API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } } },
    });
    await expect(approvalService(db).approve(approval.id, "board-user")).rejects.toMatchObject({
      status: 422, message: "Secret must belong to same company",
    });
    await expect(approvalService(db).getById(approval.id)).resolves.toMatchObject({ status: "pending" });
    await expect(agentService(db).getById(pending.id)).resolves.toMatchObject({ status: "pending_approval", adapterConfig: {} });
    expect(await db.select().from(budgetPolicies)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("rolls back the approval and newly created hire when its budget write fails", async () => {
    const companyId = await seedCompany();
    const approval = await seedHireApproval(companyId, { name: "New hire", budgetMonthlyCents: 1234 });
    await db.execute(sql`CREATE FUNCTION fail_created_hire_budget_fixture() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'created hire budget fixture failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER fail_created_hire_budget_fixture BEFORE INSERT ON budget_policies
      FOR EACH ROW EXECUTE FUNCTION fail_created_hire_budget_fixture()`);
    try {
      await expect(approvalService(db).approve(approval.id, "board-user")).rejects.toMatchObject({
        cause: { message: "created hire budget fixture failure" },
      });
    } finally {
      await db.execute(sql`DROP TRIGGER fail_created_hire_budget_fixture ON budget_policies`);
      await db.execute(sql`DROP FUNCTION fail_created_hire_budget_fixture()`);
    }
    await expect(approvalService(db).getById(approval.id)).resolves.toMatchObject({ status: "pending" });
    expect(await db.select().from(agents)).toHaveLength(0);
    expect(await db.select().from(budgetPolicies)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it.each(["pending", "revision_requested"] as const)("refuses a stale %s revision write queued behind a committing hire", async (initialStatus) => {
    const companyId = await seedCompany();
    const pending = await seedAgent(companyId, { status: "pending_approval" });
    const payload = { agentId: pending.id, name: pending.name, budgetMonthlyCents: 1234 };
    const approval = await seedHireApproval(companyId, payload);
    if (initialStatus === "revision_requested") {
      await db.update(approvals).set({ status: initialStatus }).where(eq(approvals.id, approval.id));
    }
    const svc = approvalService(db);
    // A reserved connection owns the barrier; the budget trigger stops B only
    // after its approval/agent writes, while C must read the old visible row.
    const owner = await db.$client.reserve();
    const lockKey = Number.parseInt(randomUUID().replace(/-/g, "").slice(0, 7), 16);
    let approving: Promise<unknown> | undefined;
    let revising: Promise<{ value?: unknown; error?: unknown }> | undefined;
    async function waitForPid(query: ReturnType<typeof sql>) {
      const deadline = performance.now() + 2000;
      do {
        const rows = await db.execute(query);
        const pid = Number(rows[0]?.pid);
        if (pid > 0) return pid;
      } while (performance.now() < deadline);
      throw new Error("Owned database lock barrier was not observed");
    }
    await owner`SELECT pg_advisory_lock(${lockKey})`;
    try {
      await db.execute(sql.raw(`CREATE FUNCTION hold_approval_budget_fixture() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NEW; END $$`));
      await db.execute(sql`CREATE TRIGGER hold_approval_budget_fixture BEFORE INSERT ON budget_policies
        FOR EACH ROW EXECUTE FUNCTION hold_approval_budget_fixture()`);
      approving = svc.approve(approval.id, "board-user");
      const approvingPid = await waitForPid(sql`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
        AND objid = ${lockKey} AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
      revising = (initialStatus === "pending"
        ? svc.requestRevision(approval.id, "board-user", "Stale revision")
        : svc.resubmit(approval.id, { ...payload, name: "Stale replacement", budgetMonthlyCents: 9999 }))
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await waitForPid(sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND ${approvingPid} = ANY(pg_blocking_pids(pid))`);
    } finally {
      await owner`SELECT pg_advisory_unlock(${lockKey})`;
      owner.release();
      await Promise.allSettled([approving, revising]);
      await db.execute(sql`DROP TRIGGER IF EXISTS hold_approval_budget_fixture ON budget_policies`);
      await db.execute(sql`DROP FUNCTION IF EXISTS hold_approval_budget_fixture()`);
    }
    await expect(approving).resolves.toMatchObject({ applied: true, approval: { status: "approved" } });
    await expect(svc.getById(approval.id)).resolves.toMatchObject({ status: "approved", payload });
    expect((await revising)?.error).toMatchObject({ status: 422,
      message: initialStatus === "pending" ? "Only pending approvals can request revision" : "Only revision requested approvals can be resubmitted" });
    await expect(agentService(db).getById(pending.id)).resolves.toMatchObject({ status: "idle", budgetMonthlyCents: 1234 });
    expect(await db.select().from(budgetPolicies)).toMatchObject([{ amount: 1234, scopeId: pending.id }]);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it.each(["foreign", "cycle", "budget"] as const)("rolls back a %s failure and permits an atomic corrected hire retry", async (invalidManager) => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const pending = await seedAgent(companyId, { status: "pending_approval" });
    const badManager = await seedAgent(invalidManager === "foreign" ? otherCompanyId : companyId,
      invalidManager === "cycle" ? { reportsTo: pending.id } : {});
    const manager = await seedAgent(companyId);
    // Only metadata is needed to exercise persistence/binding; no credential is resolved.
    const [secret] = await db.insert(companySecrets).values({
      companyId, key: "APPROVED_FIXTURE", name: "Approved fixture", provider: "local_encrypted",
    }).returning();
    const payload = {
      name: pending.name,
      agentId: pending.id,
      reportsTo: badManager.id,
      budgetMonthlyCents: 1234,
      adapterConfig: { env: { API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" } } },
    };
    const approval = await seedHireApproval(companyId, payload);
    const svc = approvalService(db);

    if (invalidManager === "budget") {
      // Fail after activation and secret binding writes, in this owned database.
      await db.execute(sql`CREATE FUNCTION fail_approval_budget_fixture() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'budget write fixture failure'; END $$`);
      await db.execute(sql`CREATE TRIGGER fail_approval_budget_fixture BEFORE INSERT ON budget_policies
        FOR EACH ROW EXECUTE FUNCTION fail_approval_budget_fixture()`);
      try {
        await expect(svc.approve(approval.id, "board-user")).rejects.toMatchObject({
          cause: { message: "budget write fixture failure" },
        });
      } finally {
        await db.execute(sql`DROP TRIGGER fail_approval_budget_fixture ON budget_policies`);
        await db.execute(sql`DROP FUNCTION fail_approval_budget_fixture()`);
      }
    } else {
      await expect(svc.approve(approval.id, "board-user")).rejects.toMatchObject({
        status: 422,
        message: invalidManager === "foreign" ? "Manager must belong to same company" : "Reporting relationship would create cycle",
      });
    }
    await expect(svc.getById(approval.id)).resolves.toMatchObject({
      status: "pending", decidedByUserId: null, decidedAt: null,
    });
    await expect(agentService(db).getById(pending.id)).resolves.toMatchObject({
      status: "pending_approval", reportsTo: null, budgetMonthlyCents: 0, adapterConfig: {},
    });
    expect(await db.select().from(budgetPolicies)).toHaveLength(0);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();

    await svc.requestRevision(approval.id, "board-user", "Correct manager");
    await svc.resubmit(approval.id, { ...payload, reportsTo: manager.id });
    const notificationCommitted = new Promise<void>((resolve, reject) => {
      mockNotifyHireApproved.mockImplementationOnce(async (notificationDb) => {
        try {
          // Read through the original connection, not the approval transaction.
          expect(notificationDb).toBe(db);
          await expect(approvalService(notificationDb).getById(approval.id)).resolves.toMatchObject({ status: "approved" });
          await expect(agentService(notificationDb).getById(pending.id)).resolves.toMatchObject({ status: "idle" });
          expect(await notificationDb.select().from(budgetPolicies)).toHaveLength(1);
          expect(await notificationDb.select().from(companySecretBindings)).toHaveLength(1);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    const approved = await Promise.all([
      svc.approve(approval.id, "board-user"),
      svc.approve(approval.id, "board-user"),
    ]);
    expect(approved.filter((result) => result.applied)).toHaveLength(1);
    expect(approved.every((result) => result.approval.status === "approved")).toBe(true);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
    await notificationCommitted;
    await expect(agentService(db).getById(pending.id)).resolves.toMatchObject({
      status: "idle", reportsTo: manager.id, budgetMonthlyCents: 1234,
    });
    expect(await db.select().from(budgetPolicies)).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toMatchObject([{
      companyId, targetId: pending.id, secretId: secret.id, configPath: "env.API_KEY",
    }]);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
    expect(mockNotifyHireApproved.mock.calls[0]?.[0]).toBe(db);
    const replay = await svc.approve(approval.id, "board-user");
    expect(replay.applied).toBe(false);
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
    expect(await db.select().from(budgetPolicies)).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toHaveLength(1);
  });

  it("refuses to activate a pending hire whose approved payload creates a reporting cycle", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const pending = await seedAgent(companyId, { status: "pending_approval" });
    const report = await seedAgent(companyId, { reportsTo: pending.id });

    await expect(agentSvc.activatePendingApproval(pending.id, { reportsTo: pending.id })).rejects.toMatchObject({
      status: 422,
      message: "Agent cannot report to itself",
    });
    await expect(agentSvc.activatePendingApproval(pending.id, { reportsTo: report.id })).rejects.toMatchObject({
      status: 422,
      message: "Reporting relationship would create cycle",
    });
    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "pending_approval",
      reportsTo: null,
    });
  });

  it("applies a same-company manager from the approved payload on activation", async () => {
    const companyId = await seedCompany();
    const manager = await seedAgent(companyId);
    const pending = await seedAgent(companyId, { status: "pending_approval" });

    const result = await agentService(db).activatePendingApproval(pending.id, { reportsTo: manager.id });

    expect(result).toMatchObject({ activated: true, agent: { status: "idle", reportsTo: manager.id } });
  });

  it("terminatePendingApproval leaves an agent that is no longer pending and its keys untouched", async () => {
    const companyId = await seedCompany();
    const active = await seedAgent(companyId);
    await db.insert(agentApiKeys).values({ agentId: active.id, companyId, name: "default", keyHash: "hash-active" });

    await expect(agentService(db).terminatePendingApproval(active.id)).resolves.toBeNull();

    await expect(agentService(db).getById(active.id)).resolves.toMatchObject({ status: "idle" });
    const [key] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, active.id));
    expect(key?.revokedAt).toBeNull();
  });

  it("terminatePendingApproval terminates a pending agent and revokes its keys", async () => {
    const companyId = await seedCompany();
    const pending = await seedAgent(companyId, { status: "pending_approval" });
    await db.insert(agentApiKeys).values({ agentId: pending.id, companyId, name: "default", keyHash: "hash-pending" });

    await expect(agentService(db).terminatePendingApproval(pending.id)).resolves.toMatchObject({
      id: pending.id,
      status: "terminated",
    });

    const [key] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, pending.id));
    expect(key?.revokedAt).toBeInstanceOf(Date);
  });

  it("resolves a foreign-target approval without changing or notifying the foreign pending agent", async () => {
    const companyId = await seedCompany();
    const foreignCompanyId = await seedCompany();
    const foreign = await seedAgent(foreignCompanyId, { status: "pending_approval" });
    const approval = await seedHireApproval(companyId, {
      agentId: foreign.id, name: "Injected name", budgetMonthlyCents: 1234,
    });
    await expect(approvalService(db).approve(approval.id, "board-user")).resolves.toMatchObject({
      applied: true, approval: { status: "approved" },
    });
    await expect(agentService(db).getById(foreign.id)).resolves.toMatchObject({
      status: "pending_approval", name: foreign.name, budgetMonthlyCents: 0,
    });
    expect(await db.select().from(budgetPolicies)).toHaveLength(0);
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("resolves hire approvals whose payload.agentId is not a uuid without a database error", async () => {
    const companyId = await seedCompany();
    const approvalSvc = approvalService(db);
    const toApprove = await seedHireApproval(companyId, { agentId: "not-a-uuid" });
    const toReject = await seedHireApproval(companyId, { agentId: "not-a-uuid" });

    await expect(approvalSvc.approve(toApprove.id, "board-user")).resolves.toMatchObject({
      applied: true,
      approval: { status: "approved" },
    });
    await expect(approvalSvc.reject(toReject.id, "board-user")).resolves.toMatchObject({
      applied: true,
      approval: { status: "rejected" },
    });
  });
});

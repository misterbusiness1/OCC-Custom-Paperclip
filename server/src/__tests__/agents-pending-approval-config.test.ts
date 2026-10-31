import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentApiKeys,
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";

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

  it("refuses to activate a pending hire whose approved payload reports to another company's agent", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignManager = await seedAgent(otherCompanyId);
    const pending = await seedAgent(companyId, { status: "pending_approval" });
    const approval = await seedHireApproval(companyId, {
      name: pending.name,
      agentId: pending.id,
      reportsTo: foreignManager.id,
    });

    await expect(approvalService(db).approve(approval.id, "board-user")).rejects.toMatchObject({
      status: 422,
      message: "Manager must belong to same company",
    });

    await expect(agentService(db).getById(pending.id)).resolves.toMatchObject({
      status: "pending_approval",
      reportsTo: null,
    });
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

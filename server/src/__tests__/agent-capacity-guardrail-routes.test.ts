import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
  AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
  AGENT_CAPACITY_ESCALATION_ORIGIN_KIND,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  AGENT_CAPACITY_ACTIVITY_ACTIONS,
  AGENT_CAPACITY_CONFLICT_CODE,
  awaitAgentCapacityEpisodeReconciles,
  countActiveAssignments,
  setAgentCapacityEscalationDeps,
} from "../services/agent-capacity.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent capacity guardrail tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("agent active-assignment capacity guardrail", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let wakeups: Array<{ agentId: string; opts: Record<string, unknown> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-capacity-guardrail-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  beforeEach(async () => {
    wakeups = [];
    setAgentCapacityEscalationDeps({
      createIssue: (companyId, data) => svc.create(companyId, data as Parameters<typeof svc.create>[1]),
      updateIssue: (issueId, patch) => svc.update(issueId, patch as Parameters<typeof svc.update>[1]),
      wakeup: async (agentId, opts) => {
        wakeups.push({ agentId, opts });
        return null;
      },
    });
    await setGuardrailEnabled(true);
  });

  afterEach(async () => {
    await awaitAgentCapacityEpisodeReconciles();
    setAgentCapacityEscalationDeps(null);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setGuardrailEnabled(enabled: boolean) {
    await instanceSettingsService(db).updateExperimental({
      enableActiveAssignmentCapacityGuardrail: enabled,
    });
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(
    companyId: string,
    overrides: Partial<typeof agents.$inferInsert> = {},
  ): Promise<string> {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `Agent ${id.slice(0, 8)}`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return id;
  }

  /** Seeds `count` issues that already count against the agent's active load. */
  async function seedActiveIssues(companyId: string, agentId: string, count: number) {
    if (count === 0) return [];
    const rows = Array.from({ length: count }, (_, index) => ({
      companyId,
      title: `Seeded active issue ${index}`,
      status: (["todo", "in_progress", "in_review"] as const)[index % 3],
      priority: "medium",
      assigneeAgentId: agentId,
    }));
    return db.insert(issues).values(rows).returning({ id: issues.id, status: issues.status });
  }

  async function assign(companyId: string, agentId: string, title: string, extra: Record<string, unknown> = {}) {
    try {
      return await svc.create(companyId, {
        title,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        ...extra,
      } as Parameters<typeof svc.create>[1]);
    } finally {
      // The escalation episode reconcile is scheduled post-commit; settle it so
      // assertions observe the guardrail's full effect rather than a race.
      await awaitAgentCapacityEpisodeReconciles();
    }
  }

  async function drain(issueId: string, patch: Record<string, unknown>) {
    const updated = await svc.update(issueId, patch as Parameters<typeof svc.update>[1]);
    await awaitAgentCapacityEpisodeReconciles();
    return updated;
  }

  async function activityActions(companyId: string) {
    const rows = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    return rows;
  }

  async function escalationIssues(companyId: string, agentId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, AGENT_CAPACITY_ESCALATION_ORIGIN_KIND),
          eq(issues.originId, agentId),
        ),
      );
  }

  // -------------------------------------------------------------------------
  // Counting
  // -------------------------------------------------------------------------

  it("counts exactly todo + in_progress + in_review for the target agent", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const otherAgentId = await seedAgent(companyId);

    await db.insert(issues).values([
      { companyId, title: "todo", status: "todo", assigneeAgentId: agentId },
      { companyId, title: "in_progress", status: "in_progress", assigneeAgentId: agentId },
      { companyId, title: "in_review", status: "in_review", assigneeAgentId: agentId },
      { companyId, title: "backlog", status: "backlog", assigneeAgentId: agentId },
      { companyId, title: "blocked", status: "blocked", assigneeAgentId: agentId },
      { companyId, title: "done", status: "done", assigneeAgentId: agentId },
      { companyId, title: "cancelled", status: "cancelled", assigneeAgentId: agentId },
      { companyId, title: "other agent todo", status: "todo", assigneeAgentId: otherAgentId },
      { companyId, title: "unassigned todo", status: "todo" },
    ]);

    expect(await countActiveAssignments(db, companyId, agentId)).toBe(3);
    expect(await countActiveAssignments(db, companyId, otherAgentId)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Boundaries: 44 / 45 / 49 / 50
  // -------------------------------------------------------------------------

  it("allows an assignment at 44 active issues and does not escalate below the threshold", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, 43);

    const created = await assign(companyId, agentId, "44th active issue");

    expect(created?.assigneeAgentId).toBe(agentId);
    expect(await countActiveAssignments(db, companyId, agentId)).toBe(44);
    expect(await escalationIssues(companyId, agentId)).toHaveLength(0);
  });

  it("opens exactly one manager escalation when the agent reaches 45, and wakes the manager", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, 44);

    await assign(companyId, agentId, "45th active issue");
    expect(await countActiveAssignments(db, companyId, agentId)).toBe(
      AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD,
    );

    const opened = await escalationIssues(companyId, agentId);
    expect(opened).toHaveLength(1);
    expect(opened[0].assigneeAgentId).toBe(managerId);
    expect(opened[0].status).toBe("todo");

    // The escalation must be a first-class wake, not just a row.
    expect(wakeups.filter((w) => w.agentId === managerId)).toHaveLength(1);
    expect(wakeups[0].opts).toMatchObject({ reason: "issue_assigned" });

    const escalated = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.escalated,
    );
    expect(escalated).toHaveLength(1);
    expect(escalated[0].details).toMatchObject({ targetAgentId: agentId, ownerAgentId: managerId });
  });

  it("does not re-escalate while the same cap episode is open", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, 44);

    await assign(companyId, agentId, "45th active issue");
    await assign(companyId, agentId, "46th active issue");
    await assign(companyId, agentId, "47th active issue");

    expect(await escalationIssues(companyId, agentId)).toHaveLength(1);
    expect(wakeups.filter((w) => w.agentId === managerId)).toHaveLength(1);
  });

  it("allows the assignment that lands exactly on the cap (49 -> 50)", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, 49);

    const created = await assign(companyId, agentId, "50th active issue");

    expect(created?.assigneeAgentId).toBe(agentId);
    expect(await countActiveAssignments(db, companyId, agentId)).toBe(AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
  });

  it("rejects a new active assignment at the cap with a conflict carrying the capacity code", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);

    await expect(assign(companyId, agentId, "51st active issue")).rejects.toMatchObject({
      status: 409,
      details: {
        code: AGENT_CAPACITY_CONFLICT_CODE,
        targetAgentId: agentId,
        activeCount: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
        projectedCount: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP + 1,
      },
    });

    // The rejected assignment must not have landed...
    expect(await countActiveAssignments(db, companyId, agentId)).toBe(AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
    // ...and the block evidence must survive the rollback the rejection causes.
    const blocked = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.blocked,
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].details).toMatchObject({
      targetAgentId: agentId,
      activeCount: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
      mutation: "issue.create",
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  it("cannot be pushed over the cap by concurrent assignment attempts", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP - 1);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => assign(companyId, agentId, `Concurrent claim ${index}`)),
    );

    await awaitAgentCapacityEpisodeReconciles();
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    }
    expect(await countActiveAssignments(db, companyId, agentId)).toBe(AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
  });

  // -------------------------------------------------------------------------
  // Drain transitions must stay open at the cap
  // -------------------------------------------------------------------------

  it.each(["blocked", "backlog", "done", "cancelled"] as const)(
    "allows draining an active issue to %s while the agent is at the cap",
    async (target) => {
      const companyId = await seedCompany();
      const managerId = await seedAgent(companyId, { role: "manager" });
      const agentId = await seedAgent(companyId, { reportsTo: managerId });
      const seeded = await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);

      const updated = await drain(seeded[0].id, { status: target });

      expect(updated?.status).toBe(target);
      expect(await countActiveAssignments(db, companyId, agentId)).toBe(
        AGENT_ACTIVE_ASSIGNMENT_HARD_CAP - 1,
      );
    },
  );

  it("allows reassignment away from a saturated agent but rejects reassignment onto one", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const saturatedId = await seedAgent(companyId, { reportsTo: managerId });
    const spareId = await seedAgent(companyId, { reportsTo: managerId });
    const seeded = await seedActiveIssues(companyId, saturatedId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
    const [spareIssue] = await seedActiveIssues(companyId, spareId, 1);

    // Away from the saturated agent: always allowed, it reduces load.
    const movedAway = await drain(seeded[0].id, { assigneeAgentId: spareId });
    expect(movedAway?.assigneeAgentId).toBe(spareId);

    // Onto the saturated agent: rejected. It was back down to 49, then the move
    // above pushed it to 49 again, so top it back up first.
    await seedActiveIssues(companyId, saturatedId, 1);
    expect(await countActiveAssignments(db, companyId, saturatedId)).toBe(
      AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
    );
    await expect(svc.update(spareIssue.id, { assigneeAgentId: saturatedId })).rejects.toMatchObject({
      status: 409,
      details: { code: AGENT_CAPACITY_CONFLICT_CODE },
    });
  });

  it("allows a saturated agent to keep moving work it already owns between active statuses", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    const seeded = await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
    const todoIssue = seeded.find((row) => row.status === "todo")!;

    const updated = await drain(todoIssue.id, { status: "in_review" });
    expect(updated?.status).toBe("in_review");
  });

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  it("rejects checkout of an unowned issue by a saturated agent", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
    const [unowned] = await db
      .insert(issues)
      .values({ companyId, title: "Unowned work", status: "todo" })
      .returning({ id: issues.id });

    await expect(svc.checkout(unowned.id, agentId, ["todo"], randomUUID())).rejects.toMatchObject({
      status: 409,
      details: { code: AGENT_CAPACITY_CONFLICT_CODE, mutation: "issue.checkout" },
    });
  });

  it("lets a saturated agent check out work it already owns (resume is not a new assignment)", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
    const [owned] = await db
      .insert(issues)
      .values({ companyId, title: "Own parked work", status: "backlog", assigneeAgentId: agentId })
      .returning({ id: issues.id });

    const checkedOut = await svc.checkout(owned.id, agentId, ["backlog"], null);
    await awaitAgentCapacityEpisodeReconciles();
    expect(checkedOut?.status).toBe("in_progress");
  });

  // -------------------------------------------------------------------------
  // Override
  // -------------------------------------------------------------------------

  it("permits a critical-priority override with a reason and records full audit evidence", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    const actorAgentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);

    const created = await assign(companyId, agentId, "Production incident", {
      priority: "critical",
      createdByAgentId: actorAgentId,
      capacityOverride: { reason: "Sev1 checkout outage, on-call owns this" },
    });

    expect(created?.assigneeAgentId).toBe(agentId);
    expect(await countActiveAssignments(db, companyId, agentId)).toBe(
      AGENT_ACTIVE_ASSIGNMENT_HARD_CAP + 1,
    );

    const overrides = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.overridden,
    );
    expect(overrides).toHaveLength(1);
    // Actor, target agent, issue, count and reason must all be named.
    expect(overrides[0].details).toMatchObject({
      actorType: "agent",
      actorId: actorAgentId,
      targetAgentId: agentId,
      activeCount: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
      overrideReason: "Sev1 checkout outage, on-call owns this",
      issueId: created!.id,
      priority: "critical",
    });
  });

  it("rejects an override on a non-critical issue", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);

    await expect(
      assign(companyId, agentId, "Not actually urgent", {
        priority: "high",
        capacityOverride: { reason: "I would like to skip the queue" },
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "agent_capacity_override_invalid" } });

    expect(await countActiveAssignments(db, companyId, agentId)).toBe(AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
  });

  // -------------------------------------------------------------------------
  // Episode reset
  // -------------------------------------------------------------------------

  it("closes the escalation episode only after the agent drops back below the threshold", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    const seeded = await seedActiveIssues(companyId, agentId, 44);
    await assign(companyId, agentId, "45th active issue");

    const [escalation] = await escalationIssues(companyId, agentId);
    expect(escalation.status).toBe("todo");

    // 45 -> 44 is still at the threshold boundary from above; it must close only
    // once the agent is strictly below 45.
    await drain(seeded[0].id, { status: "done" });
    const [afterDrain] = await escalationIssues(companyId, agentId);
    expect(afterDrain.status).toBe("done");

    const resets = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.episodeReset,
    );
    expect(resets).toHaveLength(1);

    // A later re-saturation opens a fresh episode rather than reusing the closed one.
    await seedActiveIssues(companyId, agentId, 1);
    await assign(companyId, agentId, "re-saturating issue");
    const all = await escalationIssues(companyId, agentId);
    expect(all).toHaveLength(2);
    expect(all.filter((row) => row.status !== "done")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Manager routing
  // -------------------------------------------------------------------------

  it("routes the escalation upward past a manager who is also at capacity", async () => {
    const companyId = await seedCompany();
    const directorId = await seedAgent(companyId, { role: "director" });
    const managerId = await seedAgent(companyId, { role: "manager", reportsTo: directorId });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, managerId, AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD);
    await seedActiveIssues(companyId, agentId, 44);

    await assign(companyId, agentId, "45th active issue");

    const [escalation] = await escalationIssues(companyId, agentId);
    expect(escalation.assigneeAgentId).toBe(directorId);

    const escalated = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.escalated,
    );
    expect(escalated[0].details).toMatchObject({ skippedSaturatedAgentIds: [managerId] });
  });

  it("records an unroutable escalation instead of assigning to a saturated chain", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, managerId, AGENT_ACTIVE_ASSIGNMENT_WARN_THRESHOLD);
    await seedActiveIssues(companyId, agentId, 44);

    await assign(companyId, agentId, "45th active issue");

    expect(await escalationIssues(companyId, agentId)).toHaveLength(0);
    const unroutable = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.escalationUnroutable,
    );
    expect(unroutable).toHaveLength(1);
    expect(unroutable[0].details).toMatchObject({ skippedSaturatedAgentIds: [managerId] });
  });

  // -------------------------------------------------------------------------
  // Kill switch: disabled means observed, never silent
  // -------------------------------------------------------------------------

  it("records an observation instead of rejecting when the guardrail flag is off", async () => {
    await setGuardrailEnabled(false);
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);

    const created = await assign(companyId, agentId, "Over-cap while disabled");

    expect(created?.assigneeAgentId).toBe(agentId);
    const observed = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.observed,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0].details).toMatchObject({ mode: "observe", outcome: "observed" });
  });

  // -------------------------------------------------------------------------
  // Route surface
  // -------------------------------------------------------------------------

  it("surfaces the cap rejection as a 409 with a machine-readable code over HTTP", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Over cap via HTTP", assigneeAgentId: agentId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe(AGENT_CAPACITY_CONFLICT_CODE);
    expect(res.body.details).toMatchObject({
      targetAgentId: agentId,
      cap: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
    });
  });
  it("passes a critical checkout override through HTTP and records audit evidence", async () => {
    const companyId = await seedCompany();
    const managerId = await seedAgent(companyId, { role: "manager" });
    const agentId = await seedAgent(companyId, { reportsTo: managerId });
    await seedActiveIssues(companyId, agentId, AGENT_ACTIVE_ASSIGNMENT_HARD_CAP);
    const [criticalIssue] = await db
      .insert(issues)
      .values({ companyId, title: "Critical checkout", status: "todo", priority: "critical" })
      .returning({ id: issues.id });
    const overrideReason = "Sev1 checkout outage, on-call owns this";

    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/issues/${criticalIssue.id}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo"],
        capacityOverride: { reason: overrideReason },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: criticalIssue.id,
      assigneeAgentId: agentId,
      status: "in_progress",
    });
    expect(await countActiveAssignments(db, companyId, agentId)).toBe(
      AGENT_ACTIVE_ASSIGNMENT_HARD_CAP + 1,
    );

    const overrides = (await activityActions(companyId)).filter(
      (row) => row.action === AGENT_CAPACITY_ACTIVITY_ACTIONS.overridden,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0].details).toMatchObject({
      actorType: "agent",
      actorId: agentId,
      targetAgentId: agentId,
      issueId: criticalIssue.id,
      activeCount: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP,
      projectedCount: AGENT_ACTIVE_ASSIGNMENT_HARD_CAP + 1,
      overrideReason,
      mutation: "issue.checkout",
      priority: "critical",
    });
  });

});

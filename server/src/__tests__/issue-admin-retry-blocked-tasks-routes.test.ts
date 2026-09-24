import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const RETRY_BLOCKED_TASK_QUEUED_ACTION = "issue.admin_retry_blocked_task_queued";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres admin retry-blocked-tasks route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("admin retry-blocked-tasks route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-admin-retry-blocked-tasks-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  // A blocked issue with no unresolved blocker relations reports
  // blockerAttention.state = "needs_attention" (see listIssueBlockerAttentionMap),
  // which is one of the two states the retry classifier treats as actionable.
  async function seedBlockedIssue(
    companyId: string,
    agentId: string,
    overrides: Partial<typeof issues.$inferInsert> = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked task",
      status: "blocked",
      priority: "high",
      assigneeAgentId: agentId,
      ...overrides,
    });
    return issueId;
  }

  async function seedTransientFailedRun(companyId: string, agentId: string, issueId: string) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      invocationSource: "manual",
      errorCode: "adapter_failed",
      error: "upstream connection reset",
      finishedAt: new Date(),
      contextSnapshot: { issueId },
    });
  }

  it("restricts admin retry-blocked-tasks to board users", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await request(createApp(agentActor(companyId, agentId, randomUUID())))
      .post(`/api/companies/${companyId}/issues/admin/retry-blocked-tasks`)
      .send({})
      .expect(403);
  });

  it("previews eligible blocked issues without mutating when dryRun is omitted", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedBlockedIssue(companyId, agentId);
    await seedTransientFailedRun(companyId, agentId, issueId);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues/admin/retry-blocked-tasks`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, evaluated: 1, eligible: 1, queued: [] });
    expect(res.body.candidates[0]).toMatchObject({
      issueId,
      eligible: true,
      reason: "eligible",
      retryCount: 0,
      maxRetries: 3,
    });

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stranded_issue_recovery"));
    expect(recoveryIssues).toHaveLength(0);

    const retryActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, RETRY_BLOCKED_TASK_QUEUED_ACTION));
    expect(retryActivity).toHaveLength(0);
  });

  it("commits with explicit dryRun:false, queues a recovery issue, and records durable retry state", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedBlockedIssue(companyId, agentId);
    await seedTransientFailedRun(companyId, agentId, issueId);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues/admin/retry-blocked-tasks`)
      .send({ dryRun: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.queued).toHaveLength(1);

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stranded_issue_recovery"))
      .then((rows) => rows[0]);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      assigneeAgentId: agentId,
      companyId,
    });

    const retryActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(eq(activityLog.action, RETRY_BLOCKED_TASK_QUEUED_ACTION), eq(activityLog.entityId, issueId)),
      );
    expect(retryActivity).toHaveLength(1);
    expect(retryActivity[0]?.details).toMatchObject({
      previousRetryCount: 0,
      retryCount: 1,
      maxRetries: 3,
      recoveryIssueId: recoveryIssue!.id,
    });
  });

  it("excludes critical-priority and user-authored blocked issues from eligibility", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const criticalIssueId = await seedBlockedIssue(companyId, agentId, { priority: "critical" });
    await seedTransientFailedRun(companyId, agentId, criticalIssueId);
    const userAuthoredIssueId = await seedBlockedIssue(companyId, agentId, {
      createdByUserId: "board-user",
    });
    await seedTransientFailedRun(companyId, agentId, userAuthoredIssueId);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues/admin/retry-blocked-tasks`)
      .send({ dryRun: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.eligible).toBe(0);
    expect(res.body.queued).toHaveLength(0);
    const reasonsByIssueId = Object.fromEntries(
      res.body.candidates.map((c: { issueId: string; reason: string }) => [c.issueId, c.reason]),
    );
    expect(reasonsByIssueId[criticalIssueId]).toBe("critical_priority");
    expect(reasonsByIssueId[userAuthoredIssueId]).toBe("user_authored_directive");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stranded_issue_recovery"));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("enforces the 30-minute cooldown after a committed retry, then the retry cap once maxRetries is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedBlockedIssue(companyId, agentId);
    await seedTransientFailedRun(companyId, agentId, issueId);

    const app = createApp(boardActor(companyId));

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues/admin/retry-blocked-tasks`)
      .send({ dryRun: false });
    expect(first.body.queued).toHaveLength(1);

    const second = await request(app)
      .post(`/api/companies/${companyId}/issues/admin/retry-blocked-tasks`)
      .send({ dryRun: false });
    expect(second.body.candidates[0]).toMatchObject({ eligible: false, reason: "cooldown_active" });
    expect(second.body.queued).toHaveLength(0);

    // Age the durable retry activity row past both the 30-minute cooldown
    // and prove the retry cap (maxRetries: 1) now wins instead.
    await db
      .update(activityLog)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(activityLog.action, RETRY_BLOCKED_TASK_QUEUED_ACTION));

    const third = await request(app)
      .post(`/api/companies/${companyId}/issues/admin/retry-blocked-tasks`)
      .send({ dryRun: false, maxRetries: 1 });
    expect(third.body.candidates[0]).toMatchObject({ eligible: false, reason: "retry_cap_reached" });
    expect(third.body.queued).toHaveLength(0);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(eq(issues.originKind, "stranded_issue_recovery"));
    expect(recoveryIssues).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  function createApp(input: { companyId: string; agentId: string; runId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: input.agentId,
        companyId: input.companyId,
        runId: input.runId,
        source: "local_jwt",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("lets a correctly attributed timer run PATCH and comment after checkout", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Timer Attribution Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        source: "scheduler",
      },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Timer-selected work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp({ companyId, agentId, runId });
    const authenticated = (call: request.Test) => call
      .set("X-Paperclip-Run-Id", runId);

    await authenticated(request(app).post(`/api/issues/${issueId}/checkout`))
      .send({ agentId, expectedStatuses: ["todo"] })
      .expect(200);
    await authenticated(request(app).patch(`/api/issues/${issueId}`))
      .send({ title: "Timer-selected work updated" })
      .expect(200);
    await authenticated(request(app).post(`/api/issues/${issueId}/comments`))
      .send({ body: "Timer run can report progress." })
      .expect(201);

    const persistedRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(persistedRun?.contextSnapshot).toMatchObject({ issueId, taskId: issueId, wakeReason: "heartbeat_timer" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toEqual([
      expect.objectContaining({ body: "Timer run can report progress.", createdByRunId: runId }),
    ]);
  });

  it.each([
    ["non-timer invocation", "on_demand", { wakeReason: "heartbeat_timer" }],
    ["missing wake reason", "timer", {}],
    ["malformed wake reason", "timer", { wakeReason: 42 }],
    ["mismatched wake reason", "timer", { wakeReason: "issue_assigned" }],
  ] as const)("denies PATCH and comment for %s", async (_name, invocationSource, contextSnapshot) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Timer Attribution Negative Company",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Negative Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource,
      triggerDetail: "system",
      status: "running",
      contextSnapshot,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Invalid timer origin",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });

    const authenticated = (call: request.Test) => call
      .set("X-Paperclip-Run-Id", runId);
    const app = createApp({ companyId, agentId, runId });
    for (const response of [
      await authenticated(request(app).patch(`/api/issues/${issueId}`)).send({ title: "Denied update" }),
      await authenticated(request(app).post(`/api/issues/${issueId}/comments`)).send({ body: "Denied comment" }),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.details?.code).toBe("cross_issue_influence_run_context_required");
    }

    const persistedRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(persistedRun?.contextSnapshot).toEqual(contextSnapshot);
  });

  it.each([
    ["company", { company: false, agent: true, issue: true, run: true }, [404, 404]],
    ["agent", { company: true, agent: false, issue: true, run: true }, [409, 403]],
    ["issue", { company: true, agent: true, issue: false, run: true }, [404, 404]],
    ["run", { company: true, agent: true, issue: true, run: false }, [409, 403]],
  ] as const)(
    "fails closed at HTTP level for a %s checkout-lock mismatch",
    async (_name, match, expectedStatuses) => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Lock Company", issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "Other Lock Company", issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Lock Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: otherAgentId, companyId, name: "Other Lock Agent", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { issueId: otherIssueId },
    });
    await db.insert(issues).values({
      id: match.issue ? issueId : otherIssueId,
      companyId: match.company ? companyId : otherCompanyId,
      title: "Mismatched lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: match.agent ? agentId : otherAgentId,
      checkoutRunId: match.run ? runId : otherRunId,
    });

    const app = createApp({ companyId, agentId, runId });
    const authenticated = (call: request.Test) => call.set("X-Paperclip-Run-Id", runId);
    const responses = [
      await authenticated(request(app).patch(`/api/issues/${issueId}`)).send({ title: "Denied mismatch update" }),
      await authenticated(request(app).post(`/api/issues/${issueId}/comments`)).send({ body: "Denied mismatch comment" }),
    ];
    expect(responses.map((response) => response.status)).toEqual(expectedStatuses);
    for (const response of responses.filter((candidate) => candidate.status === 403)) {
      expect(response.body.details?.code).toBe("cross_issue_influence_run_context_required");
    }
    expect(await db.select().from(issueComments)).toEqual([]);
    const persistedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, match.issue ? issueId : otherIssueId))
      .then((rows) => rows[0]);
    expect(persistedIssue?.title).toBe("Mismatched lock");
    const persistedRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(persistedRun?.contextSnapshot).toEqual({ wakeReason: "heartbeat_timer" });
    },
  );

  it("keeps an already-bound origin immutable despite a matching checkout lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const boundIssueId = randomUUID();
    const targetIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Immutable Origin Company",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Immutable Origin Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const contextSnapshot = {
      issueId: boundIssueId,
      taskId: boundIssueId,
      wakeReason: "heartbeat_timer",
    };
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      contextSnapshot,
    });
    await db.insert(issues).values({
      id: targetIssueId,
      companyId,
      title: "Matching checkout must not replace origin",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });

    const decision = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "update",
    });

    expect(decision).toMatchObject({ allowed: true, count: 1 });
    const persistedRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]);
    expect(persistedRun?.contextSnapshot).toEqual(contextSnapshot);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(
      Array.from({ length: 18 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // A comment, a PATCH, and an issue-thread interaction resolution race for the
    // last slot of the shared budget: the row lock must let exactly one of 19/20
    // through per attempt and fail the twenty-first closed.
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, input),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
      observeCrossIssueInfluence(db, { ...input, kind: "interaction_resolution" }),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([19, 20, 21]);

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });
});

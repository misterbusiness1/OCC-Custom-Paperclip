import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Fork (PR #97 / PR #104) acceptance test with real services: a board decision
// on the approval route reaches the requesting agent through heartbeat
// wakeup() admission, the run-dispatch claim gates and executeRun, in the
// v2026.916.1 module layout. The route tests in approval-routes-idempotency
// mock the heartbeat and issue services.

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: { runId: string }) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Board decision received.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval decision delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER_ID = "board-user";

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describeEmbeddedPostgres("approval decisions reach the requesting agent (fork PR #97 / PR #104)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-decision-delivery-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 30_000);

  afterEach(async () => {
    // Decision runs finish asynchronously inside the route's heartbeat
    // service; let them settle before truncating.
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await waitFor(async () => {
      const live = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
      return live.length === 0;
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    mockAdapterExecute.mockClear();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await db.execute(sql.raw(`
          TRUNCATE TABLE
            "issue_approvals",
            "approvals",
            "issue_relations",
            "issue_comments",
            "issues",
            "heartbeat_run_events",
            "activity_log",
            "heartbeat_runs",
            "agent_wakeup_requests",
            "agent_runtime_state",
            "company_memberships",
            "agents",
            "companies"
          RESTART IDENTITY CASCADE
        `));
        return;
      } catch (error) {
        if (attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: BOARD_USER_ID,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", approvalRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed(input: {
    issueStatus: "in_review" | "done" | "blocked";
    humanOwned?: boolean;
    blocked?: boolean;
    conversation?: boolean;
  }) {
    const companyId = randomUUID();
    const requesterAgentId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: BOARD_USER_ID,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER_ID,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values({
      id: requesterAgentId,
      companyId,
      name: "SocialMediaManager",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting on a board decision",
      status: input.issueStatus,
      priority: "medium",
      assigneeAgentId: input.humanOwned ? null : requesterAgentId,
      assigneeUserId: input.humanOwned ? BOARD_USER_ID : null,
      responsibleUserId: BOARD_USER_ID,
      ...(input.conversation ? {
        conversationAgentId: requesterAgentId,
        conversationUserId: BOARD_USER_ID,
        conversationState: "waiting",
      } : {}),
      ...(input.issueStatus === "done" ? { completedAt: new Date() } : {}),
    });
    if (input.blocked) {
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Upstream dependency",
        status: "todo",
        priority: "high",
        responsibleUserId: BOARD_USER_ID,
      });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      requestedByAgentId: requesterAgentId,
      status: "pending",
      payload: {
        title: "Publish the launch post",
        recommendedAction: "Approve the post",
        reasoning: "It is ready.",
        pros: ["On schedule"],
        risks: ["Typos"],
      },
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId, linkedByAgentId: requesterAgentId });
    return { companyId, requesterAgentId, issueId, approvalId };
  }

  async function waitForDecisionRun(agentId: string, wakeReason: string) {
    return waitFor(async () => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' = ${wakeReason}`,
        ));
      return run && !["queued", "running", "scheduled_retry"].includes(run.status) ? run : null;
    });
  }

  async function requesterWakeActivity(approvalId: string) {
    return db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, approvalId),
        sql`${activityLog.action} like 'approval.requester_wakeup_%'`,
      ));
  }

  function replyToConversation(fixture: Awaited<ReturnType<typeof seed>>) {
    // Chat completion requires a durable assistant reply, as a real provider
    // supplies. A process exit alone must not mark an unanswered chat settled.
    mockAdapterExecute.mockImplementationOnce(async ({ runId }) => {
      await db.insert(issueComments).values({
        companyId: fixture.companyId, issueId: fixture.issueId,
        authorAgentId: fixture.requesterAgentId, createdByRunId: runId,
        body: "Board decision received.",
      });
      return {
        exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Board decision received.", provider: "test", model: "test-model",
      };
    });
  }

  it.each([
    ["approve", "approval_approved", "approved"],
    ["reject", "approval_rejected", "rejected"],
    ["request-revision", "approval_revision_requested", "revision_requested"],
  ])("%s resumes a waiting chat without another user message", async (action, wakeReason, approvalStatus) => {
    const fixture = await seed({ issueStatus: "in_review", conversation: true });
    replyToConversation(fixture);
    const app = createApp(fixture.companyId);
    const res = await request(app)
      .post(`/api/approvals/${fixture.approvalId}/${action}`)
      .send({ decisionNote: "Neutral chat delivery regression check" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await requesterWakeActivity(fixture.approvalId)).map((row) => row.action))
      .toEqual(["approval.requester_wakeup_queued"]);

    const run = await waitForDecisionRun(fixture.requesterAgentId, wakeReason);
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(run.contextSnapshot).toMatchObject({
      issueId: fixture.issueId, approvalId: fixture.approvalId, approvalStatus,
      conversationSessionGeneration: 0,
    });
    expect(mockAdapterExecute.mock.calls.filter(([ctx]) => (ctx as any)?.runId === run.id)).toHaveLength(1);

    const chat = await waitFor(async () => {
      const [current] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
      return current?.conversationState === "waiting" && current.executionRunId === null ? current : null;
    });
    expect(chat).toMatchObject({
      status: "in_review", conversationState: "waiting",
      conversationAgentId: fixture.requesterAgentId, executionRunId: null,
    });

    if (action !== "request-revision") {
      const repeated = await request(app)
        .post(`/api/approvals/${fixture.approvalId}/${action}`)
        .send({ decisionNote: "Repeated delivery must not create another run" });
      expect(repeated.status).toBe(200);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, fixture.requesterAgentId));
      expect(runs).toHaveLength(1);
    }
  }, 30_000);

  it.each([
    "pending decision",
    "wrong decision status",
    "missing approval",
    "unlinked approval",
    "another chat",
    "another company",
    "another requester",
    "another chat owner",
    "agent-supplied event",
    "decision predating chat reset",
  ])("does not wake a waiting chat for %s", async (scenario) => {
    const fixture = await seed({ issueStatus: "in_review", conversation: true });
    await db.update(approvals).set({
      status: "approved", decidedByUserId: BOARD_USER_ID, decidedAt: new Date(),
      createdAt: new Date(Date.now() - 60_000),
    }).where(eq(approvals.id, fixture.approvalId));
    let approvalId = fixture.approvalId;
    let approvalStatus = "approved";
    let actorType: "user" | "agent" = "user";
    let actorId = BOARD_USER_ID;

    if (scenario === "pending decision") {
      await db.update(approvals).set({ status: "pending", decidedAt: null })
        .where(eq(approvals.id, approvalId));
    } else if (scenario === "wrong decision status") {
      approvalStatus = "rejected";
    } else if (scenario === "missing approval") {
      approvalId = randomUUID();
    } else if (scenario === "unlinked approval" || scenario === "another chat") {
      await db.delete(issueApprovals).where(eq(issueApprovals.approvalId, approvalId));
      if (scenario === "another chat") {
        const otherIssueId = randomUUID();
        await db.insert(issues).values({
          id: otherIssueId, companyId: fixture.companyId, title: "Another person's chat",
          status: "in_review", conversationState: "waiting",
          assigneeAgentId: fixture.requesterAgentId, conversationAgentId: fixture.requesterAgentId,
          conversationUserId: "another-user", responsibleUserId: BOARD_USER_ID,
        });
        await db.insert(issueApprovals).values({
          companyId: fixture.companyId, issueId: otherIssueId, approvalId,
        });
      }
    } else if (scenario === "another company") {
      approvalId = (await seed({ issueStatus: "in_review", conversation: true })).approvalId;
      await db.update(approvals).set({ status: "approved", decidedByUserId: BOARD_USER_ID, decidedAt: new Date() })
        .where(eq(approvals.id, approvalId));
    } else if (scenario === "another requester") {
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId, companyId: fixture.companyId, name: "Other Planner", role: "engineer",
        status: "idle", adapterType: "process",
      });
      await db.update(approvals).set({ requestedByAgentId: otherAgentId }).where(eq(approvals.id, approvalId));
    } else if (scenario === "another chat owner") {
      actorId = "another-board-user";
      await db.update(approvals).set({ decidedByUserId: actorId }).where(eq(approvals.id, approvalId));
    } else if (scenario === "agent-supplied event") {
      actorType = "agent";
    } else if (scenario === "decision predating chat reset") {
      const boundaryId = randomUUID();
      await db.insert(issueComments).values({
        id: boundaryId, companyId: fixture.companyId, issueId: fixture.issueId,
        authorUserId: BOARD_USER_ID, body: "/new",
      });
      await db.update(issues).set({ conversationBoundaryCommentId: boundaryId, conversationSessionGeneration: 1 })
        .where(eq(issues.id, fixture.issueId));
    }

    const wakeReason = `approval_${approvalStatus}`;
    const run = await heartbeatService(db).wakeup(fixture.requesterAgentId, {
      source: "automation", triggerDetail: "system", reason: wakeReason,
      requestedByActorType: actorType, requestedByActorId: actorId,
      idempotencyKey: `chat-boundary-regression:${randomUUID()}`,
      payload: { issueId: fixture.issueId, approvalId, approvalStatus },
      contextSnapshot: { issueId: fixture.issueId, approvalId, approvalStatus, wakeReason },
    });
    expect(run).toBeNull();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("delivers a new decision in the current reset chat session", async () => {
    const fixture = await seed({ issueStatus: "in_review", conversation: true });
    replyToConversation(fixture);
    const boundaryId = randomUUID();
    await db.insert(issueComments).values({
      id: boundaryId, companyId: fixture.companyId, issueId: fixture.issueId,
      authorUserId: BOARD_USER_ID, body: "/new", createdAt: new Date(Date.now() - 60_000),
    });
    await db.update(issues).set({ conversationBoundaryCommentId: boundaryId, conversationSessionGeneration: 1 })
      .where(eq(issues.id, fixture.issueId));
    const res = await request(createApp(fixture.companyId))
      .post(`/api/approvals/${fixture.approvalId}/approve`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const run = await waitForDecisionRun(fixture.requesterAgentId, "approval_approved");
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(run.contextSnapshot?.conversationSessionGeneration).toBe(1);
  }, 30_000);

  it("approve hands a human-parked in_review issue back to the requester and runs the decision", async () => {
    const fixture = await seed({ issueStatus: "in_review", humanOwned: true });

    const res = await request(createApp(fixture.companyId))
      .post(`/api/approvals/${fixture.approvalId}/approve`)
      .send({ decisionNote: "Go ahead" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The route records the wake outcome before it answers.
    expect((await requesterWakeActivity(fixture.approvalId)).map((row) => row.action))
      .toEqual(["approval.requester_wakeup_queued"]);

    const run = await waitForDecisionRun(fixture.requesterAgentId, "approval_approved");
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => (ctx as any)?.runId === run.id)).toBe(true);

    const [issue] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    expect(issue.assigneeAgentId).toBe(fixture.requesterAgentId);
    expect(issue.assigneeUserId).toBeNull();
    expect(["todo", "in_progress"]).toContain(issue.status);

    const activity = await requesterWakeActivity(fixture.approvalId);
    expect(activity).toEqual([
      expect.objectContaining({
        action: "approval.requester_wakeup_queued",
        details: expect.objectContaining({ approvalStatus: "approved", wakeRunId: run.id }),
      }),
    ]);
  });

  it("reject still reaches the requester after it closed the linked issue, without reopening it", async () => {
    const fixture = await seed({ issueStatus: "done" });

    const res = await request(createApp(fixture.companyId))
      .post(`/api/approvals/${fixture.approvalId}/reject`)
      .send({ decisionNote: "Not this week" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await requesterWakeActivity(fixture.approvalId)).map((row) => row.action))
      .toEqual(["approval.requester_wakeup_queued"]);

    const run = await waitForDecisionRun(fixture.requesterAgentId, "approval_rejected");
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => (ctx as any)?.runId === run.id)).toBe(true);

    const [issue] = await db
      .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    expect(issue).toEqual({ status: "done", assigneeAgentId: fixture.requesterAgentId });

  });

  it("request-revision runs as a bounded interaction on a dependency-blocked issue", async () => {
    const fixture = await seed({ issueStatus: "blocked", blocked: true });

    const res = await request(createApp(fixture.companyId))
      .post(`/api/approvals/${fixture.approvalId}/request-revision`)
      .send({ decisionNote: "Tighten the copy" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await requesterWakeActivity(fixture.approvalId)).map((row) => row.action))
      .toEqual(["approval.requester_wakeup_queued"]);

    const run = await waitForDecisionRun(fixture.requesterAgentId, "approval_revision_requested");
    expect(run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(run.contextSnapshot).toMatchObject({
      approvalId: fixture.approvalId,
      dependencyBlockedInteraction: true,
    });

    const [issue] = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.issueId));
    expect(issue.status).toBe("blocked");

  });
});

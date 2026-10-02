import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.ts";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));
import { heartbeatService } from "../services/heartbeat.ts";

describe("deferred handoff recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-deferred-handoff-");
    db = createDb(temporary.connectionString);
    await db.execute(sql`SET client_min_messages = warning`);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (ctx: AdapterExecutionContext) => {
      // Simulate the reviewer completing only this isolated fixture task.
      await db.update(issues).set({ status: "done" })
        .where(eq(issues.id, String(ctx.context.issueId)));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Review complete." };
    });
  }, 30_000);
  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE companies CASCADE`);
    execute.mockClear();
  });
  afterAll(async () => { await temporary?.cleanup(); }, 30_000);

  async function seed(reason = "issue_assigned") {
    const companyId = randomUUID(), authorId = randomUUID(), reviewerId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), commentId = randomUUID();
    const createdAt = new Date(Date.now() - 60_000);
    await db.insert(companies).values({
      id: companyId, name: "Handoff", issuePrefix: `H${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "test-operator", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([authorId, reviewerId].map((id, index) => ({
      id, companyId, name: index ? "Reviewer" : "Author", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    })));
    await db.insert(issues).values({
      id: issueId, companyId, title: "Completed work awaiting review", status: "todo",
      assigneeAgentId: reviewerId, responsibleUserId: "test-operator",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: authorId, invocationSource: "assignment",
      status: "cancelled", runtimeMode: "legacy", errorCode: "issue_reassigned",
      createdAt, startedAt: createdAt, finishedAt: new Date(),
      contextSnapshot: { issueId }, responsibleUserId: "test-operator",
      // A live local owner makes ordinary wake admission persist an execution wait.
      processPid: process.pid,
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      resultJson: { conversationContinuation: "continue_conversation_v1",
        executionCancellation: { state: "acknowledged" } },
    });
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId, authorType: "agent", authorAgentId: authorId,
      createdByRunId: runId, body: "Work and artifacts are complete. @Reviewer please review.",
    });
    expect(await heartbeat.wakeup(reviewerId, {
      source: reason === "issue_assigned" ? "assignment" : "automation",
      triggerDetail: "system", reason,
      payload: { issueId, commentId, interruptedRunId: runId },
      contextSnapshot: { issueId, taskId: issueId, taskKey: issueId,
        wakeReason: reason, wakeCommentId: commentId, wakeCommentIds: [commentId], interruptedRunId: runId },
      requestedByActorType: "agent", requestedByActorId: authorId,
    })).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, reviewerId),
    ));
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    return { companyId, authorId, reviewerId, issueId, runId, commentId, wakeId: wake.id };
  }

  async function stopOwner(f: Awaited<ReturnType<typeof seed>>) {
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.runId));
  }
  async function sweep() {
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
  }
  async function wakeFor(f: Awaited<ReturnType<typeof seed>>) {
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId)))[0];
  }

  it.each(["issue_assigned", "issue_comment_mentioned"])(
    "delivers saved %s to a new reviewer exactly once after the old owner stops", async reason => {
      const f = await seed(reason);
      await sweep();
      expect(execute).not.toHaveBeenCalled();
      await stopOwner(f);
      await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);
      await heartbeat.drainActiveRunExecutions();
      await sweep();
      expect(execute).toHaveBeenCalledTimes(1);
      const ctx = execute.mock.calls[0][0] as AdapterExecutionContext;
      expect(ctx.agent.id).toBe(f.reviewerId);
      expect(ctx.context.wakeCommentIds).toContain(f.commentId);
      expect(await wakeFor(f)).toMatchObject({
        requestedByActorType: "agent", requestedByActorId: f.authorId,
        runId: ctx.runId,
      });
      expect((await wakeFor(f)).status).not.toBe("deferred_issue_execution");
      expect((await heartbeat.getRun(ctx.runId))?.status).toBe("succeeded");
      expect((await db.select().from(issueComments).where(eq(issueComments.id, f.commentId)))[0].body)
        .toBe("Work and artifacts are complete. @Reviewer please review.");
    },
  );

  it.each(["operator_stop", "same_assignee", "human_assignee", "archived_company", "paused_agent",
    "cancelled_issue", "newer_stop", "native_source", "recovery_hold", "deleted_comment"])(
    "does not restart held or obsolete work (%s)", async scenario => {
      const f = await seed("issue_comment_mentioned");
      await stopOwner(f);
      if (scenario === "operator_stop") await db.update(heartbeatRuns).set({ errorCode: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "same_assignee") await db.update(issues).set({ assigneeAgentId: f.authorId }).where(eq(issues.id, f.issueId));
      if (scenario === "human_assignee") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "test-operator" }).where(eq(issues.id, f.issueId));
      if (scenario === "archived_company") await db.update(companies).set({ status: "archived" }).where(eq(companies.id, f.companyId));
      if (scenario === "paused_agent") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerId));
      if (scenario === "cancelled_issue") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      if (scenario === "native_source") await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.runId));
      if (scenario === "deleted_comment") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.commentId));
      if (scenario === "newer_stop") await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.reviewerId, invocationSource: "on_demand", status: "cancelled",
        contextSnapshot: { issueId: f.issueId }, errorCode: "cancelled", finishedAt: new Date(),
        resultJson: { conversationContinuation: "continue_conversation_v1", executionCancellation: { state: "acknowledged" } },
      });
      if (scenario === "recovery_hold") await db.insert(issueRecoveryActions).values({
        companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", ownerType: "board",
        cause: "legacy_execution_requires_reconciliation", status: "resolved", fingerprint: f.runId,
        evidence: { automaticRecovery: { replay: "blocked" } }, nextAction: "Verify the prior execution.",
      });
      await sweep();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["queued", "running", "scheduled_retry", "cancelled", "succeeded"])(
    "late old-owner cleanup cannot duplicate or override a newer %s turn", async status => {
      const f = await seed();
      await stopOwner(f);
      await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.reviewerId, invocationSource: "assignment", status,
        contextSnapshot: { issueId: f.issueId },
        resultJson: status === "cancelled" ? { executionCancellation: { state: "acknowledged" } } : null,
      });
      const adapter = createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "test-operator",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      });
      const drain = vi.fn(async () => ({ outcome: { kind: "released" as const }, postCommitEffects: [] }));
      await adapter.withIssueExecutionLock({ companyId: f.companyId, runId: f.runId, now: new Date() }, drain);
      expect(drain).not.toHaveBeenCalled();
      expect(await wakeFor(f)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    },
  );
});

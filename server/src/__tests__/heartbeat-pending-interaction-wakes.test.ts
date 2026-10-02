import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueComments, issueRelations, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null,
  summary: "Readiness wake completed.", provider: "test", model: "test-model",
})));
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));
import { heartbeatService } from "../services/heartbeat.ts";

describe("automatic readiness wakes while an interaction is pending", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-pending-wake-");
    db = createDb(temporary.connectionString);
    await db.execute(sql`SET client_min_messages = warning`);
    heartbeat = heartbeatService(db);
  }, 30_000);
  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE companies CASCADE`);
    execute.mockClear();
  });
  afterAll(async () => { await temporary?.cleanup(); }, 30_000);

  async function seed(options: {
    interactionStatus?: string;
    continuationPolicy?: string;
    interactionOnOtherIssue?: boolean;
    interactionInOtherCompany?: boolean;
    differentAssignee?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const blockerId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Pending interaction", issuePrefix: `W${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test-operator",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    let assigneeAgentId = agentId;
    if (options.differentAssignee) {
      assigneeAgentId = randomUUID();
      await db.insert(agents).values({
        id: assigneeAgentId, companyId, name: "Assignee", role: "engineer", status: "idle",
        adapterType: "codex_local", adapterConfig: {}, permissions: {},
      });
    }
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Wait for a human response", status: "blocked",
        assigneeAgentId, responsibleUserId: "test-operator" },
      { id: blockerId, companyId, title: "Finished dependency", status: "done" },
    ]);
    await db.insert(issueRelations).values({
      companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks",
    });
    let interactionCompanyId = companyId;
    let interactionIssueId = issueId;
    if (options.interactionInOtherCompany) {
      interactionCompanyId = randomUUID();
      await db.insert(companies).values({
        id: interactionCompanyId, name: "Other company", issuePrefix: `X${interactionCompanyId.slice(0, 6)}`,
      });
    }
    if (options.interactionOnOtherIssue) {
      interactionIssueId = randomUUID();
      await db.insert(issues).values({
        id: interactionIssueId, companyId: interactionCompanyId, title: "Unrelated question", status: "blocked",
      });
    }
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: interactionCompanyId, issueId: interactionIssueId,
      kind: "request_item_verdicts", status: options.interactionStatus ?? "pending",
      continuationPolicy: options.continuationPolicy ?? "wake_assignee",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit", effectiveResolverPolicySource: "requested",
      title: "Human decision required", payload: { version: 1, items: [], verdicts: ["approve", "reject"] },
    }).returning({ id: issueThreadInteractions.id });
    return { companyId, agentId, issueId, blockerId, interactionId: interaction.id };
  }

  function options(f: Awaited<ReturnType<typeof seed>>, reason: string) {
    return {
      source: "automation" as const, triggerDetail: "system" as const, reason,
      payload: { issueId: f.issueId, resolvedBlockerIssueId: f.blockerId },
      contextSnapshot: { issueId: f.issueId, wakeReason: reason },
      requestedByActorType: "system" as const,
      idempotencyKey: `readiness:${f.issueId}:${reason}`,
    };
  }

  it.each(["issue_blockers_resolved", "issue_unblock_requested"])(
    "does not dispatch %s back to an assignee waiting on a response", async (reason) => {
      const f = await seed();
      expect(await heartbeat.wakeup(f.agentId, options(f, reason))).toBeNull();
      expect(await heartbeat.wakeup(f.agentId, options(f, reason))).toBeNull();
      await heartbeat.drainActiveRunExecutions();
      expect(execute).not.toHaveBeenCalled();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ status: "skipped", reason: "issue_interaction_pending" });
      expect(wakes[0].coalescedCount).toBe(1);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
    },
  );

  it("waits for an accept-only interaction continuation", async () => {
    const f = await seed({ continuationPolicy: "wake_assignee_on_accept" });
    expect(await heartbeat.wakeup(f.agentId, options(f, "issue_blockers_resolved"))).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
  });

  it("can dispatch the same readiness signal after the response is resolved", async () => {
    const f = await seed();
    const wake = options(f, "issue_blockers_resolved");
    expect(await heartbeat.wakeup(f.agentId, wake)).toBeNull();
    await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date() })
      .where(eq(issueThreadInteractions.id, f.interactionId));
    expect(await heartbeat.wakeup(f.agentId, wake)).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalled();
  });

  it.each([
    { name: "an answered interaction", interactionStatus: "answered" },
    { name: "an expired interaction", interactionStatus: "expired" },
    { name: "a cancelled interaction", interactionStatus: "cancelled" },
    { name: "an interaction that does not request continuation", continuationPolicy: "none" },
    { name: "a pending interaction on a different issue", interactionOnOtherIssue: true },
    { name: "a foreign-company interaction record for the same issue", interactionInOtherCompany: true },
  ])("still dispatches with $name", async ({ name: _name, ...fixtureOptions }) => {
    const f = await seed(fixtureOptions);
    expect(await heartbeat.wakeup(f.agentId, options(f, "issue_blockers_resolved"))).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalled();
  });

  it("preserves admission of a distinct unblock owner's notification", async () => {
    const f = await seed({ differentAssignee: true });
    expect(await heartbeat.wakeup(f.agentId, options(f, "issue_unblock_requested"))).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes.every((wake) => wake.reason !== "issue_interaction_pending")).toBe(true);
  });

  it("preserves an explicit manual wake", async () => {
    const f = await seed();
    expect(await heartbeat.wakeup(f.agentId, {
      ...options(f, "manual_check"), source: "on_demand", triggerDetail: "manual",
      requestedByActorType: "user", requestedByActorId: "test-operator", manualUserWake: true,
    })).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  async function seedComment(f: Awaited<ReturnType<typeof seed>>) {
    const [comment] = await db.insert(issueComments).values({
      companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "test-operator", body: "Please review this additional information while the decision is pending.",
    }).returning({ id: issueComments.id });
    return comment.id;
  }

  it("preserves a user comment coalesced with an automatic readiness signal", async () => {
    const f = await seed();
    const commentId = await seedComment(f);
    const wake = options(f, "issue_blockers_resolved");
    expect(await heartbeat.wakeup(f.agentId, {
      ...wake, payload: { ...wake.payload, commentId },
      contextSnapshot: { ...wake.contextSnapshot, wakeCommentId: commentId, wakeCommentIds: [commentId] },
    })).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalled();
  });

  async function seedQueuedReadiness(f: Awaited<ReturnType<typeof seed>>, commentId?: string) {
    const runId = randomUUID();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, reason: "issue_blockers_resolved",
      source: "automation", triggerDetail: "system", payload: { issueId: f.issueId }, status: "queued",
    }).returning({ id: agentWakeupRequests.id });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "automation", triggerDetail: "system", status: "queued", wakeupRequestId: wake.id,
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_blockers_resolved",
        ...(commentId ? { commentId, wakeCommentId: commentId, wakeCommentIds: [commentId] } : {}) },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wake.id));
    await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    return { runId, wakeId: wake.id };
  }

  it("cancels a readiness run queued before the interaction was created", async () => {
    const f = await seed();
    const { runId, wakeId } = await seedQueuedReadiness(f);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0])
      .toMatchObject({ status: "cancelled", errorCode: "issue_interaction_pending" });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status)
      .toBe("skipped");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "blocked", executionRunId: null });
  });

  it("preserves a queued user comment even when its run has an automatic readiness reason", async () => {
    const f = await seed();
    const commentId = await seedComment(f);
    const { runId } = await seedQueuedReadiness(f, commentId);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].errorCode)
      .not.toBe("issue_interaction_pending");
  });

  it("promotes a deferred user comment when cancelling the old readiness run", async () => {
    const f = await seed();
    const { runId } = await seedQueuedReadiness(f);
    const commentId = await seedComment(f);
    const [commentWake] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, reason: "issue_execution_deferred",
      source: "automation", triggerDetail: "system", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "test-operator",
      payload: { issueId: f.issueId, commentId,
        _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented",
          commentId, wakeCommentId: commentId, wakeCommentIds: [commentId] } },
    }).returning({ id: agentWakeupRequests.id });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].errorCode)
      .toBe("issue_interaction_pending");
    expect(execute).toHaveBeenCalled();
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, commentWake.id));
    expect(delivered.runId).not.toBeNull();
    expect(delivered.status).not.toBe("deferred_issue_execution");
  });

  it("does not dispatch a persisted native dependency intent while waiting on a response", async () => {
    const f = await seed();
    await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, reason: "issue_blockers_resolved",
      source: "automation", triggerDetail: "system", status: "queued",
      requestedByActorType: "system", requestedByActorId: "native-status-committer",
      idempotencyKey: `native-dependency:${f.issueId}`,
      payload: { issueId: f.issueId, taskId: f.issueId,
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, source: "native_status_decision", wakeReason: "issue_blockers_resolved" } },
    });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(0);
    const pending = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.status, "queued"),
    ));
    expect(pending).toHaveLength(0);
  });
});

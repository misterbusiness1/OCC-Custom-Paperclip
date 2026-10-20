import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns,
  issueComments, issueRelations, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const adapterState = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  sideEffects: 0,
}));
const execute = vi.hoisted(() => vi.fn(async () => {
  await adapterState.gate;
  adapterState.sideEffects += 1;
  return {
    exitCode: 0, signal: null, timedOut: false, errorMessage: null,
    summary: "Readiness wake completed.", provider: "test", model: "test-model",
  };
}));
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { deliverAgentUnblockNotification } from "../services/routable-blocked.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

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
    adapterState.gate = null;
    adapterState.sideEffects = 0;
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

  async function scheduleFutureMonitor(f: Awaited<ReturnType<typeof seed>>) {
    const nextCheckAt = new Date(Date.now() + 60 * 60_000);
    await db.update(issues).set({
      monitorNextCheckAt: nextCheckAt,
      executionPolicy: { monitor: {
        kind: "external_service", nextCheckAt: nextCheckAt.toISOString(),
        maxAttempts: 4, scheduledBy: "assignee", notes: "Wait for publication",
      } },
    }).where(eq(issues.id, f.issueId));
    return nextCheckAt;
  }

  it.each(["issue_blockers_resolved", "issue_unblock_requested"])(
    "parks %s until the assignee's scheduled monitor is due", async (reason) => {
      const f = await seed({ interactionStatus: "answered" });
      await scheduleFutureMonitor(f);
      for (let cycle = 0; cycle < 3; cycle++) {
        const wake = options(f, reason);
        expect(await heartbeat.wakeup(f.agentId, {
          ...wake, idempotencyKey: `${wake.idempotencyKey}:${cycle}`,
        })).toBeNull();
      }
      await heartbeat.drainActiveRunExecutions();
      expect(execute).not.toHaveBeenCalled();
      const wakes = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ reason: "issue_monitor_pending", coalescedCount: 2 });
    },
  );

  it("does not turn a checkout/re-block into a new self-unblock session before a due monitor", async () => {
    const f = await seed({ interactionStatus: "answered" });
    const svc = issueService(db);
    await svc.checkout(f.issueId, f.agentId, ["blocked"], null);
    const blocked = await svc.update(f.issueId, {
      status: "blocked", unblockDescriptor: { owner: { agentId: f.agentId }, action: "Wait for publication" },
    });
    await scheduleFutureMonitor(f);
    await deliverAgentUnblockNotification({
      issue: blocked!, wakeup: heartbeat.wakeup,
      markNotified: async (blockedOwnerNotifiedAt) => {
        await db.update(issues).set({ blockedOwnerNotifiedAt }).where(eq(issues.id, f.issueId));
      },
    });
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId });
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId, source: "workspace.finalize", blockerIssueId: f.blockerId });
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ status: "blocked", executionRunId: null });
  });

  it("rechecks a monitor scheduled after a readiness run was queued", async () => {
    const f = await seed({ interactionStatus: "answered" });
    const { runId, wakeId } = await seedQueuedReadiness(f);
    await scheduleFutureMonitor(f);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0])
      .toMatchObject({ status: "cancelled", errorCode: "issue_monitor_pending" });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status)
      .toBe("skipped");
  });

  it("delivers a same-blocker cycle created during its due-monitor turn exactly once", async () => {
    const f = await seed({ interactionStatus: "answered" });
    const svc = issueService(db);
    const gate = deferred<void>();
    adapterState.gate = gate.promise;
    await scheduleFutureMonitor(f);
    const dueAt = new Date(Date.now() - 1_000);
    await db.update(issues).set({
      status: "in_review",
      monitorNextCheckAt: dueAt,
    }).where(eq(issues.id, f.issueId));
    await svc.update(f.blockerId, { status: "todo" });
    await svc.update(f.blockerId, { status: "done" });

    expect(await heartbeat.triggerIssueMonitor(f.issueId, {
      actorType: "system",
      actorId: "test-monitor-scheduler",
      now: new Date(),
    })).toMatchObject({ outcome: "triggered" });
    await vi.waitFor(
      () => expect(execute).toHaveBeenCalledTimes(1),
      { timeout: 5_000 },
    );
    // Keep this fixture focused on dependency-ready generation dedup. The real
    // canary maintains a pending approval; this smaller fixture uses an answered
    // interaction, so move it out of review before finalization can schedule the
    // unrelated review-path repair.
    await db.update(issues).set({ status: "in_progress" })
      .where(eq(issues.id, f.issueId));
    const generationBefore = await svc.getById(f.blockerId);
    await svc.update(f.blockerId, { status: "todo" });
    const generationBetween = await svc.getById(f.blockerId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await svc.update(f.blockerId, { status: "done" });
    const generationAfter = await svc.getById(f.blockerId);
    expect(generationBefore?.completedAt).toBeInstanceOf(Date);
    expect(generationBetween?.completedAt).toBeNull();
    expect(generationAfter?.completedAt).toBeInstanceOf(Date);
    expect(generationAfter?.completedAt?.toISOString())
      .not.toBe(generationBefore?.completedAt?.toISOString());
    const beforeRelease = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId));
    expect(beforeRelease.map((run) => ({
      status: run.status,
      wakeReason: (run.contextSnapshot as Record<string, unknown>)?.wakeReason,
    }))).toEqual([{ status: "running", wakeReason: "issue_monitor_due" }]);

    gate.resolve();
    await heartbeat.drainActiveRunExecutions();
    const finalRuns = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId));
    expect(finalRuns.map((run) => ({
      status: run.status,
      wakeReason: (run.contextSnapshot as Record<string, unknown>)?.wakeReason,
    }))).toEqual([{ status: "succeeded", wakeReason: "issue_monitor_due" }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(adapterState.sideEffects).toBe(1);
    expect(finalRuns).toHaveLength(1);

    await db.update(issues).set({ status: "in_review" })
      .where(eq(issues.id, f.issueId));
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId });
    await db.update(issues).set({ status: "in_progress" })
      .where(eq(issues.id, f.issueId));
    await heartbeat.drainActiveRunExecutions();
    const reconciledRuns = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId));
    expect(reconciledRuns).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(adapterState.sideEffects).toBe(2);
    await db.update(issues).set({ status: "in_review" })
      .where(eq(issues.id, f.issueId));
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(adapterState.sideEffects).toBe(2);

    // Re-sending DONE is not a new dependency-ready generation. Exercise the
    // real service/transaction path and prove both the persisted completion
    // metadata and downstream execution count remain stable.
    const consumedGeneration = await svc.getById(f.blockerId);
    await svc.update(f.blockerId, { status: "done" });
    const repeatedDoneGeneration = await svc.getById(f.blockerId);
    expect(repeatedDoneGeneration?.completedAt?.toISOString())
      .toBe(consumedGeneration?.completedAt?.toISOString());
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId });
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(adapterState.sideEffects).toBe(2);

    const successorAgentId = randomUUID();
    await db.insert(agents).values({
      id: successorAgentId,
      companyId: f.companyId,
      name: "Successor owner",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.update(issues).set({
      assigneeAgentId: successorAgentId,
      status: "in_review",
    })
      .where(eq(issues.id, f.issueId));
    await heartbeat.reconcileResolvedDependencyWakes({ companyId: f.companyId });
    await db.update(issues).set({ status: "in_progress" })
      .where(eq(issues.id, f.issueId));
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(adapterState.sideEffects).toBe(3);
  });

  it("still admits a due monitor and a fresh user comment", async () => {
    const f = await seed({ interactionStatus: "answered" });
    await scheduleFutureMonitor(f);
    const commentId = await seedComment(f);
    const wake = options(f, "issue_blockers_resolved");
    expect(await heartbeat.wakeup(f.agentId, {
      ...wake, contextSnapshot: { ...wake.contextSnapshot, commentId, wakeCommentId: commentId },
    })).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalled();
    await db.update(issues).set({ status: "blocked", monitorNextCheckAt: new Date(Date.now() - 1_000) })
      .where(eq(issues.id, f.issueId));
    expect(await heartbeat.wakeup(f.agentId, {
      ...options(f, "issue_blockers_resolved"), idempotencyKey: `monitor-due:${f.issueId}`,
    })).not.toBeNull();
  });

  it("preserves a distinct unblock owner's work while the assignee has a future monitor", async () => {
    const f = await seed({ interactionStatus: "answered", differentAssignee: true });
    await scheduleFutureMonitor(f);
    expect(await heartbeat.wakeup(f.agentId, options(f, "issue_unblock_requested"))).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const wakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes.every(wake => wake.reason !== "issue_monitor_pending")).toBe(true);
  });

  it("preserves an explicit manual wake despite a future monitor", async () => {
    const f = await seed({ interactionStatus: "answered" });
    await scheduleFutureMonitor(f);
    expect(await heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "manual",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, wakeReason: "manual" },
    })).not.toBeNull();
  });

  it("parks a persisted native dependency intent until the scheduled monitor is due", async () => {
    const f = await seed({ interactionStatus: "answered" });
    await scheduleFutureMonitor(f);
    await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, reason: "issue_blockers_resolved",
      source: "automation", triggerDetail: "system", status: "queued",
      requestedByActorType: "system", requestedByActorId: "native-status-committer",
      idempotencyKey: `native-monitor:${f.issueId}`,
      payload: { issueId: f.issueId, taskId: f.issueId,
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, source: "native_status_decision", wakeReason: "issue_blockers_resolved" } },
    });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(0);
  });

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

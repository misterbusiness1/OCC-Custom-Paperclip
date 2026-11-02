import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat lock-release-on-reassignment tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat lock release on cross-agent reassignment", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-lock-release-on-reassignment-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCrossAgentScenario(opts: { holderStatus: "queued" | "running" }) {
    const companyId = randomUUID();
    const coderAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const holderRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: coderAgentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: coderAgentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: coderAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.holderStatus,
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cross-agent reassignment race",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionRunId: holderRunId,
      executionAgentNameKey: "coder",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return {
      companyId,
      coderAgentId,
      reviewerAgentId,
      issueId,
      holderRunId,
      wakeupRequestId,
    };
  }

  it("defers a cross-agent wake while the holder is still running and leaves the holder alone", async () => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "running" });

    const heartbeat = heartbeatService(db);
    const followupRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(followupRun).toBeNull();

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(heldWakeup?.status).toBe("queued");

    const deferred = await db
      .select({ status: agentWakeupRequests.status, agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(deferred).not.toBeNull();

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  // Race-guard regression: the cancel UPDATE for the queued holder is pinned
  // to the exact non-running status that was read just above it. If a worker
  // races in and flips the holder from `queued` → `running` between that
  // SELECT and the cancel UPDATE, the status predicate in the WHERE clause
  // must guarantee zero rows are clobbered. We simulate the race by
  // pre-running the same UPDATE shape against a row that is already
  // `running` (the snapshot we would have read was `queued`); the row must
  // remain untouched, no wake-request cascade fires, and the lock stays
  // owned by the freshly-claimed running holder.
  it("guards the cancel UPDATE WHERE clause against a concurrent claim flip to running", async () => {
    const { coderAgentId, issueId, holderRunId, wakeupRequestId } = await seedCrossAgentScenario({
      holderStatus: "queued",
    });

    const snapshotStatus = "queued" as const;

    // Concurrent worker claims the queued run after the SELECT but before
    // the cancel UPDATE. In production this is a separate transaction
    // flipping the row from queued → running.
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));

    const cancelled = await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: new Date(),
        error: "Execution lock released after issue reassigned to a different agent",
        errorCode: "lock_released_on_reassignment",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, holderRunId),
          eq(heartbeatRuns.status, snapshotStatus),
        ),
      )
      .returning({ id: heartbeatRuns.id });

    expect(cancelled).toHaveLength(0);

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(heldWakeup?.status).toBe("queued");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  it("cancels a queued holder's run on reassignment and emits agent.task_run for it", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });

    // Keep the reviewer's queue from auto-claiming/executing the new run
    // during this unit test, matching the pattern used for the sibling
    // reassignment scenario in heartbeat-retry-scheduling.test.ts: cap
    // concurrency at 1, then occupy that one slot with a busy run.
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const newAssigneeRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(reviewerAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const holder = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder).toEqual({
      status: "cancelled",
      errorCode: "lock_released_on_reassignment",
    });

    // The cancel runs inside enqueueWakeup's transaction, and the run's own
    // required lifecycle work never awaits the telemetry emission, so wait
    // for it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: coderAgentId,
          state: "cancelled",
        }),
      );
    });
  });

  it("matches linked-pointer admission when a queued former holder has no execution pointer", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });

    // Queued receipts deliberately do not own an issue lock until claim.
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));

    // Keep the reviewer's queue from auto-claiming/executing the new run
    // during this unit test, matching the pattern used for the sibling
    // reassignment scenario in heartbeat-retry-scheduling.test.ts: cap
    // concurrency at 1, then occupy that one slot with a busy run.
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const newAssigneeRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(reviewerAgentId);
    expect(newAssigneeRun?.status).toBe("queued");
    expect(newAssigneeRun?.contextSnapshot).toMatchObject({ issueId });

    const holder = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder).toEqual({
      status: "cancelled",
      errorCode: "lock_released_on_reassignment",
    });

    const formerWake = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then(rows => rows[0] ?? null);
    expect(formerWake).toEqual({ status: "cancelled" });

    // The cancel runs inside enqueueWakeup's transaction, and the run's own
    // required lifecycle work never awaits the telemetry emission, so wait
    // for it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: coderAgentId,
          state: "cancelled",
        }),
      );
    });
  });

  it("cancels every queued former holder before admitting a new assignee without a lock pointer", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });

    // Queued receipts deliberately do not own an issue lock until claim.
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));

    const secondHolderRunId = randomUUID(), secondWakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: secondWakeupRequestId, companyId,
      agentId: coderAgentId, source: "assignment", status: "queued" });
    await db.insert(heartbeatRuns).values({ id: secondHolderRunId, companyId, agentId: coderAgentId,
      invocationSource: "assignment", triggerDetail: "system", status: "queued", wakeupRequestId: secondWakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });

    // Keep the reviewer's queue from auto-claiming/executing the new run
    // during this unit test, matching the pattern used for the sibling
    // reassignment scenario in heartbeat-retry-scheduling.test.ts: cap
    // concurrency at 1, then occupy that one slot with a busy run.
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, reviewerAgentId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: reviewerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { wakeReason: "test_busy_slot" },
      startedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const newAssigneeRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(reviewerAgentId);
    expect(newAssigneeRun?.status).toBe("queued");
    expect(newAssigneeRun?.contextSnapshot).toMatchObject({ issueId });

    const holder = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder).toEqual({
      status: "cancelled",
      errorCode: "lock_released_on_reassignment",
    });

    const formerWake = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then(rows => rows[0] ?? null);
    expect(formerWake).toEqual({ status: "cancelled" });

    const secondHolder = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, secondHolderRunId)).then(rows => rows[0] ?? null);
    expect(secondHolder).toEqual({ status: "cancelled", errorCode: "lock_released_on_reassignment" });
    const secondWake = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, secondWakeupRequestId)).then(rows => rows[0] ?? null);
    expect(secondWake).toEqual({ status: "cancelled" });

    // The cancel runs inside enqueueWakeup's transaction, and the run's own
    // required lifecycle work never awaits the telemetry emission, so wait
    // for it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: coderAgentId,
          state: "cancelled",
        }),
      );
    });
  });

  it("preserves a running former holder discovered without an execution pointer", async () => {
    const { coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "running" });

    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    const followupRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(followupRun).toBeNull();

    const holder = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        agentId: heartbeatRuns.agentId,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, holderRunId))
      .then((rows) => rows[0] ?? null);

    expect(holder?.status).toBe("running");
    expect(holder?.errorCode).toBeNull();
    expect(holder?.finishedAt).toBeNull();
    expect(holder?.agentId).toBe(coderAgentId);

    const heldWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);

    expect(heldWakeup?.status).toBe("queued");

    const deferred = await db
      .select({ status: agentWakeupRequests.status, agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, reviewerAgentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(deferred).not.toBeNull();

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.executionRunId).toBe(holderRunId);
  });

  it("rescans for an actual running holder after cancelling a linked stale queued holder", async () => {
    const { companyId, coderAgentId, reviewerAgentId, issueId, holderRunId, wakeupRequestId } =
      await seedCrossAgentScenario({ holderStatus: "queued" });
    const runningRunId = randomUUID(), runningWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: runningWakeId, companyId,
      agentId: coderAgentId, source: "assignment", status: "claimed", claimedAt: new Date() });
    await db.insert(heartbeatRuns).values({ id: runningRunId, companyId, agentId: coderAgentId,
      invocationSource: "assignment", triggerDetail: "system", status: "running", wakeupRequestId: runningWakeId,
      startedAt: new Date(), contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" } });

    const followupRun = await heartbeat.wakeup(reviewerAgentId, {
      source: "automation", triggerDetail: "system", reason: "issue_assigned", payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(followupRun).toBeNull();
    const former = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, holderRunId)).then(rows => rows[0] ?? null);
    expect(former).toEqual({ status: "cancelled", errorCode: "lock_released_on_reassignment" });
    const running = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId)).then(rows => rows[0] ?? null);
    expect(running).toEqual({ status: "running", errorCode: null, finishedAt: null });
    const oldWake = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId)).then(rows => rows[0] ?? null);
    expect(oldWake).toEqual({ status: "cancelled" });
    const runningWake = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, runningWakeId)).then(rows => rows[0] ?? null);
    expect(runningWake).toEqual({ status: "claimed" });
    const task = await db.select({ executionRunId: issues.executionRunId }).from(issues)
      .where(eq(issues.id, issueId)).then(rows => rows[0] ?? null);
    expect(task?.executionRunId).toBe(runningRunId);
  });
});

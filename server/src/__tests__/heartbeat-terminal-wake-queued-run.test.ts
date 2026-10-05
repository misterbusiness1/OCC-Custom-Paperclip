import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn());
const emitAgentTaskRun = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));
vi.mock("../services/agent-task-run-telemetry.ts", async () => ({
  ...await vi.importActual<typeof import("../services/agent-task-run-telemetry.ts")>("../services/agent-task-run-telemetry.ts"),
  emitAgentTaskRun,
}));
import { heartbeatService } from "../services/heartbeat.ts";
import { deliverExecutionStatuses } from "../services/execution-status-delivery.ts";
import { buildHeartbeatRunStatusLiveEventPayload } from "../services/heartbeat-run-status-payload.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { releaseRunClaimedJustBeforeSuppression } from "../services/heartbeat-queued-claim-release.ts";
import {
  reconcileTerminalWakeQueuedRun,
  TERMINAL_WAKE_EXECUTION_OWNERSHIP_UNVERIFIED_CODE,
  TERMINAL_WAKE_QUEUED_RUN_CODE,
} from "../services/terminal-wake-queued-run.ts";

describe("terminal-wake queued-run reconciliation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-terminal-wake-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
    execute.mockImplementation(async (_ctx: AdapterExecutionContext) => ({
      exitCode: 0, signal: null, timedOut: false, summary: "Independent work completed.",
    }));
  }, 30_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE companies CASCADE`);
    execute.mockClear();
    emitAgentTaskRun.mockClear();
  });
  afterAll(async () => { await temporary?.cleanup(); }, 30_000);

  async function seedCompany() {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Terminal wake fixture", issuePrefix: `W${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: "board-test", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
  }

  async function seedPair(input: {
    source?: "assignment" | "automation";
    wakeStatus?: "cancelled" | "failed" | "skipped" | "queued" | "claimed";
    issueId?: string | null;
    reason?: string;
    idempotencyKey?: string;
  } = {}) {
    const runId = randomUUID();
    const wakeId = randomUUID();
    const issueId = input.issueId === undefined ? randomUUID() : input.issueId;
    const source = input.source ?? "assignment";
    await db.insert(agentWakeupRequests).values({
      id: wakeId, companyId, agentId, source, status: input.wakeStatus ?? "cancelled",
      runId, reason: input.reason ?? "issue_assigned",
      payload: issueId ? { issueId } : {},
      idempotencyKey: input.idempotencyKey ?? null,
      requestedByActorType: "system", requestedByActorId: "test",
      ...((input.wakeStatus ?? "cancelled") === "queued" ? {}
        : input.wakeStatus === "claimed" ? { claimedAt: new Date() }
        : { finishedAt: new Date() }),
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: source,
      status: "queued", wakeupRequestId: wakeId,
      contextSnapshot: issueId ? { issueId, wakeReason: input.reason ?? "issue_assigned" } : {},
      responsibleUserId: "board-test",
    });
    return { runId, wakeId, issueId };
  }

  async function state(runId: string, wakeId: string) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.runId, runId),
      eq(activityLog.action, "heartbeat.terminal_wake_queued_run_reconciled"),
    ));
    return { run, wake, audits };
  }

  it.each(["cancelled", "failed", "skipped"] as const)(
    "closes a never-started assignment run whose missing issue has a %s wake, without reviving it",
    async wakeStatus => {
      await seedCompany();
      const { runId, wakeId, issueId } = await seedPair({ wakeStatus });
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const { run, wake, audits } = await state(runId, wakeId);
      expect(run).toMatchObject({
        status: "cancelled", errorCode: TERMINAL_WAKE_QUEUED_RUN_CODE,
        startedAt: null, resultJson: { terminalWakeReconciliation: {
          wakeupRequestId: wakeId, wakeStatus, providerDispatched: false,
        } },
      });
      expect(wake.status).toBe(wakeStatus);
      expect(await db.select().from(issues).where(eq(issues.id, issueId!))).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      await heartbeat.resumeQueuedRuns();
      expect((await state(runId, wakeId)).audits).toHaveLength(1);
    },
  );

  it("persists terminal status delivery and a lifecycle event, and emits task-run telemetry once", async () => {
    await seedCompany();
    const { runId, wakeId, issueId } = await seedPair();

    const onLiveEvent = vi.fn();
    const unsubscribe = subscribeCompanyLiveEvents(companyId, onLiveEvent);
    try {
      await heartbeat.resumeQueuedRuns();
    } finally {
      unsubscribe();
    }

    const { run } = await state(runId, wakeId);
    expect(run.status).toBe("cancelled");
    expect(run.executionStatusDeliveryId).toEqual(expect.any(String));
    const events = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.runId, runId),
    ));
    expect(events).toMatchObject([{
      seq: 1, eventType: "lifecycle", stream: "system", level: "warn",
      payload: { code: TERMINAL_WAKE_QUEUED_RUN_CODE, wakeupRequestId: wakeId,
        wakeStatus: "cancelled", providerDispatched: false },
    }]);
    expect(run.nextEventSeq).toBe(2);
    expect(onLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "heartbeat.run.event",
      payload: expect.objectContaining({
        runId, agentId, issueId: issueId ?? null,
        seq: events[0].seq, eventType: "lifecycle", stream: "system",
        level: "warn", message: events[0].message,
        payload: events[0].payload,
        lastEventAt: events[0].createdAt.toISOString(),
      }),
    }));
    expect(onLiveEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "heartbeat.run.status",
      payload: buildHeartbeatRunStatusLiveEventPayload(run),
    }));
    expect(emitAgentTaskRun).toHaveBeenCalledWith(db, expect.objectContaining({
      id: runId, companyId, status: "cancelled",
    }));

    const publish = vi.fn();
    await expect(deliverExecutionStatuses(db, {
      publish,
      failpoint: () => { throw new Error("simulated restart after publication"); },
    })).rejects.toThrow("simulated restart after publication");
    expect((await state(runId, wakeId)).run.executionStatusDeliveryId)
      .toBe(run.executionStatusDeliveryId);
    await deliverExecutionStatuses(db, { publish });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "heartbeat.run.status",
      payload: expect.objectContaining({
        runId, status: "cancelled", deliveryId: run.executionStatusDeliveryId,
      }),
    }));
    expect((await state(runId, wakeId)).run.executionStatusDeliveryId).toBeNull();

    await heartbeat.resumeQueuedRuns();
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(1);
    expect(emitAgentTaskRun).toHaveBeenCalledTimes(1);
  });

  it("publishes the committed run event even if a status listener fails", async () => {
    await seedCompany();
    const { runId } = await seedPair();
    const seen: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type !== "heartbeat.run.status" && event.type !== "heartbeat.run.event") return;
      seen.push(event.type);
      if (event.type === "heartbeat.run.status") throw new Error("simulated status listener failure");
    });
    try {
      await heartbeat.resumeQueuedRuns();
    } finally {
      unsubscribe();
    }

    expect(seen).toEqual(["heartbeat.run.status", "heartbeat.run.event"]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status)
      .toBe("cancelled");
  });

  it("preserves a done, reassigned issue and its agent-authored mention comment", async () => {
    await seedCompany();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId, name: "New owner", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
    });
    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Completed issue", status: "done",
      assigneeAgentId: otherAgentId,
    });
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId, authorType: "agent",
      authorAgentId: otherAgentId, body: "Existing mention remains in history.",
    });
    const { runId, wakeId } = await seedPair({
      source: "automation", reason: "issue_comment_mentioned", issueId,
    });
    await heartbeat.resumeQueuedRuns();
    const { run, wake } = await state(runId, wakeId);
    expect(run.errorCode).toBe(TERMINAL_WAKE_QUEUED_RUN_CODE);
    expect(wake.status).toBe("cancelled");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
      .toMatchObject({ status: "done", assigneeAgentId: otherAgentId });
    expect((await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0])
      .toMatchObject({ deletedAt: null, body: "Existing mention remains in history." });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not redispatch a queued run whose bound wake is already claimed", async () => {
    await seedCompany();
    const { runId, wakeId } = await seedPair({
      issueId: null, wakeStatus: "claimed", reason: "manual",
    });
    await db.update(heartbeatRuns).set({
      startedAt: new Date(), nextEventSeq: 2,
    }).where(eq(heartbeatRuns.id, runId));
    await db.insert(heartbeatRunEvents).values({
      companyId, agentId, runId, seq: 1, eventType: "adapter.invoke",
      payload: { adapterType: "codex_local" },
    });
    await heartbeat.resumeQueuedRuns();
    const { run, wake } = await state(runId, wakeId);
    expect(run.status).toBe("queued");
    expect(wake.status).toBe("claimed");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["claimed", "cancelled"] as const)(
    "suppression release preserves %s wake authority",
    async wakeStatus => {
      await seedCompany();
      const { runId, wakeId } = await seedPair({
        issueId: null, wakeStatus, reason: "manual",
      });
      const controllerBootId = randomUUID();
      await db.update(heartbeatRuns).set({
        status: "running", runtimeMode: "legacy", controllerBootId,
        executionStage: "preparing", startedAt: new Date(),
      }).where(eq(heartbeatRuns.id, runId));
      await releaseRunClaimedJustBeforeSuppression(db, runId, controllerBootId);
      const { run, wake } = await state(runId, wakeId);
      expect(run.status).toBe(wakeStatus === "claimed" ? "queued" : "running");
      expect(wake.status).toBe(wakeStatus === "claimed" ? "queued" : "cancelled");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(["checkout pointer", "deferred receipt", "controller", "event", "session", "lease", "result", "output stream", "compressed log"] as const)(
    "fails closed when ownership is ambiguous: %s",
    async evidence => {
      await seedCompany();
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Ambiguous", status: "todo" });
      const { runId, wakeId } = await seedPair({ issueId });
      if (evidence === "execution pointer") await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      if (evidence === "checkout pointer") await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, issueId));
      if (evidence === "deferred receipt") await db.insert(agentWakeupRequests).values({
        companyId, agentId, source: "automation", status: "deferred_issue_execution", payload: { issueId },
      });
      if (evidence === "controller") await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, runId));
      if (evidence === "event") await db.execute(sql`INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type) VALUES (${companyId}, ${runId}, ${agentId}, 1, 'lifecycle')`);
      if (evidence === "session") await db.insert(agentTaskSessions).values({
        companyId, agentId, adapterType: "codex_local", taskKey: issueId, lastRunId: runId,
      });
      if (evidence === "lease") await db.insert(environmentLeases).values({
        companyId, heartbeatRunId: runId, status: "active",
      });
      if (evidence === "result") await db.update(heartbeatRuns).set({
        resultJson: { adapterDispatch: "possibly_started" },
      }).where(eq(heartbeatRuns.id, runId));
      if (evidence === "output stream") await db.update(heartbeatRuns).set({
        lastOutputStream: "stdout",
      }).where(eq(heartbeatRuns.id, runId));
      if (evidence === "compressed log") await db.update(heartbeatRuns).set({
        logCompressed: true,
      }).where(eq(heartbeatRuns.id, runId));
      const [candidate] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect((await reconcileTerminalWakeQueuedRun(db, candidate)).kind).toBe("held_for_operator");
      await heartbeat.resumeQueuedRuns();
      expect((await state(runId, wakeId)).run.status).toBe("queued");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("releases this run's stale execution lock when its cancelled wake proves it never started", async () => {
    await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Blocked task with a stranded queue lock",
      status: "blocked", assigneeAgentId: agentId,
    });
    const { runId, wakeId } = await seedPair({ issueId, wakeStatus: "cancelled" });
    const executionLockedAt = new Date();
    await db.update(issues).set({
      executionRunId: runId,
      executionAgentNameKey: "worker",
      executionLockedAt,
    }).where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const { run, wake } = await state(runId, wakeId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: TERMINAL_WAKE_QUEUED_RUN_CODE });
    expect(wake.status).toBe("cancelled");
    expect(issue).toMatchObject({
      status: "blocked", assigneeAgentId: agentId, executionRunId: null,
      executionAgentNameKey: null, executionLockedAt: null,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a terminal-wake run held when a different issue points to its execution lock", async () => {
    await seedCompany();
    const { runId, wakeId } = await seedPair();
    await db.insert(issues).values({
      id: randomUUID(), companyId, title: "Other issue", status: "todo",
      executionRunId: runId,
    });

    await heartbeat.resumeQueuedRuns();

    expect((await state(runId, wakeId)).run).toMatchObject({ status: "queued" });
    expect((await state(runId, wakeId)).wake.status).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps an observed execution hold after its lease disappears", async () => {
    await seedCompany();
    const { runId, wakeId } = await seedPair();
    await db.insert(environmentLeases).values({
      companyId, heartbeatRunId: runId, status: "active",
    });
    await heartbeat.resumeQueuedRuns();
    expect((await state(runId, wakeId)).run).toMatchObject({
      status: "queued", errorCode: TERMINAL_WAKE_EXECUTION_OWNERSHIP_UNVERIFIED_CODE,
    });
    await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect((await state(runId, wakeId)).run).toMatchObject({
      status: "queued", errorCode: TERMINAL_WAKE_EXECUTION_OWNERSHIP_UNVERIFIED_CODE,
    });
    expect((await state(runId, wakeId)).wake.status).toBe("cancelled");
    const holdAudits = await db.select().from(activityLog).where(and(
      eq(activityLog.runId, runId),
      eq(activityLog.action, "heartbeat.terminal_wake_queued_run_execution_ownership_unverified"),
    ));
    expect(holdAudits).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["missing wake", "wrong run binding", "malformed issue context"] as const)(
    "holds a terminal-wake run with ambiguous binding: %s",
    async mismatch => {
      await seedCompany();
      const { runId, wakeId } = await seedPair();
      const [candidate] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (mismatch === "missing wake") candidate.wakeupRequestId = randomUUID();
      if (mismatch === "wrong run binding") await db.update(agentWakeupRequests)
        .set({ runId: randomUUID() }).where(eq(agentWakeupRequests.id, wakeId));
      if (mismatch === "malformed issue context") await db.update(heartbeatRuns)
        .set({ contextSnapshot: { issueId: "not-a-uuid" } }).where(eq(heartbeatRuns.id, runId));
      const current = mismatch === "malformed issue context"
        ? (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]
        : candidate;
      expect((await reconcileTerminalWakeQueuedRun(db, current)).kind).toBe("held_for_operator");
      if (mismatch === "wrong run binding") {
        await heartbeat.resumeQueuedRuns();
        expect((await state(runId, wakeId)).run.status).toBe("queued");
        expect(execute).not.toHaveBeenCalled();
      }
    },
  );

  it("serializes concurrent recovery scans and still dispatches independent queued work", async () => {
    await seedCompany();
    const stale = await seedPair();
    const independent = await seedPair({ issueId: null, wakeStatus: "queued", reason: "manual" });
    await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);
    await heartbeat.drainActiveRunExecutions();
    expect((await state(stale.runId, stale.wakeId)).audits).toHaveLength(1);
    expect((await state(stale.runId, stale.wakeId)).run.status).toBe("cancelled");
    expect((await state(independent.runId, independent.wakeId)).run.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
    expect((execute.mock.calls[0][0] as AdapterExecutionContext).runId).toBe(independent.runId);
  });

  it("does not claim if the wake is cancelled after the scan and before the locked claim", async () => {
    await seedCompany();
    const { runId, wakeId } = await seedPair({ issueId: null, wakeStatus: "queued", reason: "manual" });
    const racingHeartbeat = heartbeatService(db, {
      beforeQueuedWakeClaim: async candidateRunId => {
        if (candidateRunId !== runId) return;
        await db.update(agentWakeupRequests).set({
          status: "cancelled", finishedAt: new Date(),
        }).where(eq(agentWakeupRequests.id, wakeId));
      },
    });
    await racingHeartbeat.resumeQueuedRuns();
    expect((await state(runId, wakeId)).run.status).toBe("queued");
    expect((await state(runId, wakeId)).wake.status).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();

    await heartbeat.resumeQueuedRuns();
    expect((await state(runId, wakeId)).run.errorCode).toBe(TERMINAL_WAKE_QUEUED_RUN_CODE);
    expect((await state(runId, wakeId)).wake.status).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves the Board interrupt lineage for its receipt-specific recovery", async () => {
    await seedCompany();
    const issueId = randomUUID();
    const { runId, wakeId } = await seedPair({
      issueId, idempotencyKey: `queued-comment-interrupt:${randomUUID()}`,
    });
    const [candidate] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect((await reconcileTerminalWakeQueuedRun(db, candidate)).kind).toBe("not_terminal_wake");
    expect((await state(runId, wakeId)).run.status).toBe("queued");
  });
});

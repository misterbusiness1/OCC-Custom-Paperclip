import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  issues,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    // The no-op process fixtures deliberately leave no task disposition. The
    // real lifecycle can now leave a bounded, scheduled repair after the
    // monitor assertions. Cancel that remaining work only during teardown.
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Monitor fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
    monitorAttemptCount?: number;
    monitorLastTriggeredAt?: Date | null;
    monitor?: Record<string, unknown>;
    /** Agent heartbeat daily run cap; 0 makes every wake hit the cap. */
    maxDailyRuns?: number;
    /**
     * Reproduce a monitor that fired without a following check: the persisted
     * monitor state says "triggered" and no schedule is left on the row.
     */
    stranded?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitorLastTriggeredAt = input?.monitorLastTriggeredAt ?? null;
    const monitor = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };
    const stranded = input?.stranded === true;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
          ...(input?.maxDailyRuns !== undefined ? { maxDailyRuns: input.maxDailyRuns } : {}),
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        ...(stranded ? {} : { monitor }),
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: stranded ? "triggered" : "scheduled",
          nextCheckAt: stranded ? null : nextCheckAt.toISOString(),
          lastTriggeredAt: monitorLastTriggeredAt?.toISOString() ?? null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: stranded ? null : nextCheckAt,
      monitorLastTriggeredAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  async function seedIssueRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status:
      | "queued"
      | "running"
      | "scheduled_retry"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "timed_out"
      | "interrupted";
    createdAt?: Date;
    /** Defaults to a run the monitor woke. */
    source?: string;
  }) {
    const id = randomUUID();
    const terminal = !["queued", "running", "scheduled_retry"].includes(input.status);
    const source = input.source ?? "issue.monitor";
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "on_demand",
      contextSnapshot: {
        issueId: input.issueId,
        source,
        wakeReason: source === "issue.monitor" ? "issue_monitor_due" : "issue_commented",
      },
      ...(input.status === "scheduled_retry"
        ? { scheduledRetryAt: new Date("2026-04-11T13:00:00.000Z"), scheduledRetryAttempt: 1 }
        : {}),
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(terminal ? { finishedAt: new Date() } : {}),
    });
    return id;
  }

  /**
   * Changes the issue right before the stranded-monitor repair writes its
   * re-arm patch, to reproduce an issue closed or reassigned between the
   * repair scan and its claim.
   */
  function dbChangingIssueBeforeRepairClaim(
    issueId: string,
    change: Partial<typeof issues.$inferInsert>,
  ): typeof db {
    return dbChangingIssueBeforeUpdate(
      issueId,
      change,
      (values) => values.monitorNextCheckAt instanceof Date && "monitorLastTriggeredAt" in values,
    );
  }

  /**
   * Changes the issue right before the first issue update whose values match,
   * to reproduce a concurrent writer landing between a read and that write.
   */
  function dbChangingIssueBeforeUpdate(
    issueId: string,
    change: Partial<typeof issues.$inferInsert>,
    matches: (values: Record<string, unknown>) => boolean,
  ): typeof db {
    let changed = false;
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "update") return Reflect.get(target, prop, receiver);
        return (table: unknown) => {
          const builder = target.update(table as typeof issues);
          if (table !== issues) return builder;
          return new Proxy(builder, {
            get(b, p, r) {
              if (p !== "set") return Reflect.get(b, p, r);
              return (values: Record<string, unknown>) => {
                const setBuilder = b.set(values as never);
                if (changed || !matches(values)) return setBuilder;
                return {
                  where: (condition: Parameters<typeof setBuilder.where>[0]) => ({
                    returning: async (columns: Parameters<ReturnType<typeof setBuilder.where>["returning"]>[0]) => {
                      changed = true;
                      await target.update(issues).set(change).where(eq(issues.id, issueId));
                      return setBuilder.where(condition).returning(columns);
                    },
                  }),
                };
              };
            },
          });
        };
      },
    });
  }

  it("triggers a due issue monitor once and consumes it until the woken run re-arms it", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);
    const duplicateResult = await heartbeat.tickTimers(new Date(tickAt.getTime() + 1_000));

    expect(result.enqueued).toBe(1);
    expect(duplicateResult.enqueued).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    // A fire is a one-shot wake. Keeping the monitor armed made monitors
    // without bounds wake their agent forever (ORI-285 fired 15 times).
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
      notes: "Check deploy",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows);
    expect(wakeup).toHaveLength(1);
    expect(wakeup[0]?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity.filter((action) => action === "issue.monitor_triggered")).toHaveLength(1);
  });

  it("does not wake the agent again after a woken run that succeeded without re-arming", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    expect((await heartbeat.tickTimers(tickAt)).enqueued).toBe(1);
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle(10_000);

    // Hours of scheduler ticks, past every fallback interval and with the
    // stranded-monitor repair pass running each time.
    for (const minutes of [10, 31, 45, 90, 6 * 60, 25 * 60]) {
      const later = await heartbeat.tickTimers(new Date(tickAt.getTime() + minutes * 60 * 1000));
      expect(later.enqueued).toBe(0);
    }

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    const monitorWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.filter((row) => row.reason === "issue_monitor_due"));
    expect(monitorWakeups).toHaveLength(1);
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity.filter((action) => action === "issue.monitor_triggered")).toHaveLength(1);
    expect(activity).not.toContain("issue.monitor_rearmed");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it.each(["queued", "running", "scheduled_retry"] as const)(
    "does not fire a due monitor while a run for the issue is %s",
    async (status) => {
      const { companyId, issueId, agentId, nextCheckAt } = await seedFixture();
      const liveRunId = await seedIssueRun({ companyId, agentId, issueId, status });
      const heartbeat = heartbeatService(db);
      const tickAt = new Date("2026-04-11T12:31:00.000Z");

      const result = await heartbeat.tickTimers(tickAt);

      expect(result.enqueued).toBe(0);
      let issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt?.toISOString()).toBe(nextCheckAt.toISOString());
      expect(issue.monitorWakeRequestedAt).toBeNull();
      expect(issue.monitorAttemptCount).toBe(0);
      expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

      // The monitor stays due and fires once the live run has ended.
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, liveRunId));
      const afterRun = await heartbeat.tickTimers(new Date(tickAt.getTime() + 60_000));
      expect(afterRun.enqueued).toBe(1);
      issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(issue.monitorAttemptCount).toBe(1);
    },
  );

  it.each(["failed", "timed_out", "interrupted"] as const)(
    "re-arms a fired monitor once when the woken run %s before it could re-arm, and says so on the issue",
    async (runStatus) => {
      const lastTriggeredAt = new Date("2026-04-11T12:30:00.000Z");
      const { companyId, issueId, agentId } = await seedFixture({
        stranded: true,
        monitorLastTriggeredAt: lastTriggeredAt,
      });
      await seedIssueRun({
        companyId,
        agentId,
        issueId,
        status: runStatus,
        createdAt: new Date(lastTriggeredAt.getTime() + 1_000),
      });
      const heartbeat = heartbeatService(db);
      const tickAt = new Date("2026-04-11T12:31:00.000Z");

      const result = await heartbeat.tickTimers(tickAt);

      expect(result.enqueued).toBe(0);

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue.monitorNextCheckAt).not.toBeNull();
      expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(tickAt.getTime());
      expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor).toMatchObject({
        notes: "Check deploy",
      });
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled",
      });

      const comments = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .then((rows) => rows);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.body).toContain("restored the scheduled monitor");
      expect(comments[0]?.body).toContain("failed, timed out or was interrupted");

      const activity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.map((row) => row.action));
      expect(activity).toContain("issue.monitor_rearmed");
    },
  );

  it.each([
    ["the woken run succeeded", "succeeded"],
    ["the woken run was cancelled (a deliberate stop)", "cancelled"],
    ["a run for the issue is still running", "running"],
    ["a bounded retry of the woken run is scheduled", "scheduled_retry"],
    ["no run followed the fire", null],
  ] as const)("does not re-arm a fired monitor when %s", async (_label, runStatus) => {
    const lastTriggeredAt = new Date("2026-04-11T12:30:00.000Z");
    const { companyId, issueId, agentId } = await seedFixture({
      stranded: true,
      monitorLastTriggeredAt: lastTriggeredAt,
    });
    if (runStatus) {
      await seedIssueRun({
        companyId,
        agentId,
        issueId,
        status: runStatus,
        createdAt: new Date(lastTriggeredAt.getTime() + 1_000),
      });
    }
    const heartbeat = heartbeatService(db);

    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    await heartbeat.tickTimers(new Date("2026-04-11T14:31:00.000Z"));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("does not re-arm when the woken run succeeded and a later run from another wake failed", async () => {
    const lastTriggeredAt = new Date("2026-04-11T12:30:00.000Z");
    const { companyId, issueId, agentId } = await seedFixture({
      stranded: true,
      monitorLastTriggeredAt: lastTriggeredAt,
    });
    await seedIssueRun({
      companyId, agentId, issueId, status: "succeeded",
      createdAt: new Date(lastTriggeredAt.getTime() + 1_000),
    });
    await seedIssueRun({
      companyId, agentId, issueId, status: "failed", source: "issue.comment",
      createdAt: new Date(lastTriggeredAt.getTime() + 60_000),
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
  });

  it("re-arms when the woken run failed although a later run from another wake succeeded", async () => {
    const lastTriggeredAt = new Date("2026-04-11T12:30:00.000Z");
    const { companyId, issueId, agentId } = await seedFixture({
      stranded: true,
      monitorLastTriggeredAt: lastTriggeredAt,
    });
    await seedIssueRun({
      companyId, agentId, issueId, status: "failed",
      createdAt: new Date(lastTriggeredAt.getTime() + 1_000),
    });
    await seedIssueRun({
      companyId, agentId, issueId, status: "succeeded", source: "issue.comment",
      createdAt: new Date(lastTriggeredAt.getTime() + 60_000),
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).not.toBeNull();
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("keeps the monitor armed at the fallback interval when the fire's wake is skipped", async () => {
    // maxDailyRuns 0: every wake hits the daily cap, so the fire starts no run
    // and nothing could re-arm a consumed monitor.
    const { issueId, agentId, nextCheckAt } = await seedFixture({ maxDailyRuns: 0 });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.status).toBe("skipped");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).not.toBeNull();
    expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(tickAt.getTime());
    expect(issue.monitorNextCheckAt!.toISOString()).not.toBe(nextCheckAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor).toMatchObject({
      notes: "Check deploy",
    });
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({ status: "scheduled" });

    const triggered = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.find((row) => row.action === "issue.monitor_triggered"));
    expect(triggered?.details).toMatchObject({
      wakeSkipped: true,
      wakeSkipReason: "heartbeat.daily_run_limit",
      fallbackNextCheckAt: issue.monitorNextCheckAt!.toISOString(),
    });
  });

  it("keeps a re-arm the woken run wrote before the fire's own write", async () => {
    const { issueId } = await seedFixture();
    const rearmedAt = new Date("2026-04-11T14:00:00.000Z");
    const rearmedPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [],
      monitor: { nextCheckAt: rearmedAt.toISOString(), notes: "Check again", scheduledBy: "assignee" },
    };
    const heartbeat = heartbeatService(
      dbChangingIssueBeforeUpdate(
        issueId,
        { monitorNextCheckAt: rearmedAt, executionPolicy: rearmedPolicy, monitorWakeRequestedAt: null },
        (values) => "monitorLastTriggeredAt" in values && "monitorAttemptCount" in values,
      ),
    );
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    expect((await heartbeat.tickTimers(tickAt)).enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe(rearmedAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor).toMatchObject({
      notes: "Check again",
    });
    const triggered = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.find((row) => row.action === "issue.monitor_triggered"));
    expect(triggered?.details).toMatchObject({ scheduleUpdated: false });
  });

  it("fires a provider-quota monitor although another run for the issue is live", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Reviewer Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    seededAgentIds.add(otherAgentId);
    await seedIssueRun({ companyId, agentId: otherAgentId, issueId, status: "queued", source: "issue.comment" });
    const heartbeat = heartbeatService(db);

    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(retries).toHaveLength(1);
  });

  it.each([
    ["closed as done", { status: "done" }],
    ["cancelled", { status: "cancelled" }],
    ["reassigned to a user", { assigneeAgentId: null, assigneeUserId: "board-user" }],
  ] as const)(
    "does not re-arm or comment when the issue was %s between the repair scan and its claim",
    async (_label, change) => {
      const lastTriggeredAt = new Date("2026-04-11T12:30:00.000Z");
      const { companyId, issueId, agentId } = await seedFixture({
        stranded: true,
        monitorLastTriggeredAt: lastTriggeredAt,
      });
      await seedIssueRun({
        companyId,
        agentId,
        issueId,
        status: "failed",
        createdAt: new Date(lastTriggeredAt.getTime() + 1_000),
      });
      const heartbeat = heartbeatService(dbChangingIssueBeforeRepairClaim(issueId, change));

      await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

      const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
      expect(issue).toMatchObject(change);
      expect(issue.monitorNextCheckAt).toBeNull();
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
      const activity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.entityId, issueId))
        .then((rows) => rows.map((row) => row.action));
      expect(activity).not.toContain("issue.monitor_rearmed");
    },
  );

  it("does not re-arm when the issue was reassigned to another agent between the repair scan and its claim", async () => {
    const lastTriggeredAt = new Date("2026-04-11T12:30:00.000Z");
    const { companyId, issueId, agentId } = await seedFixture({
      stranded: true,
      monitorLastTriggeredAt: lastTriggeredAt,
    });
    await seedIssueRun({
      companyId,
      agentId,
      issueId,
      status: "failed",
      createdAt: new Date(lastTriggeredAt.getTime() + 1_000),
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    seededAgentIds.add(otherAgentId);
    const heartbeat = heartbeatService(
      dbChangingIssueBeforeRepairClaim(issueId, { assigneeAgentId: otherAgentId }),
    );

    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.assigneeAgentId).toBe(otherAgentId);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
  });

  it.each(["unknown", "exhausted"] as const)("does not replay a quota monitor with %s execution evidence", async (kind) => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId } = await seedFixture({
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "failed", errorCode: "provider_quota",
      finishedAt: new Date("2026-04-11T12:00:00.000Z"), contextSnapshot: { issueId },
      scheduledRetryAttempt: kind === "exhausted" ? 2 : 0,
      resultJson: kind === "exhausted" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    });
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(issueRecoveryActions)).toMatchObject([{ ownerType: "board", evidence: { runId: sourceRunId } }]);
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const sourceRunId = randomUUID();
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: sourceRunId },
    });    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId: participantAgentId, status: "failed",
      errorCode: "provider_quota", finishedAt: new Date("2026-04-11T12:00:00.000Z"),
      contextSnapshot: { issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    const [scheduled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, sourceRunId));
    expect(scheduled).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(await heartbeat.promoteDueScheduledRetries(scheduled.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await heartbeat.resumeQueuedRuns();
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(2);
    expect(participantRuns.find((run) => run.id === scheduled.id)?.errorCode).not.toBe("issue_assignee_changed");

    // The provider-quota monitor is the documented exception: it is consumed by
    // its fire because its continuation is the bounded retry chain, not
    // another scheduled check.
    const quotaIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(quotaIssue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(quotaIssue.executionState)?.monitor).toMatchObject({
      status: "triggered",
    });
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = heartbeatService(db);
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    // A board-triggered check consumes the monitor like a scheduled one.
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      notes: "Check deploy",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: null,
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = heartbeatService(db);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });
});

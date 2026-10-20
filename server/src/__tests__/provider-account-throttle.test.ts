import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexAcpExecutor, createCodexProviderAccountKey } from "@paperclipai/adapter-codex-local/server";
import { agents, companies, createDb, heartbeatRuns, issues, runIdentityContexts } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { lockProviderAccountAdmission, providerAccountRecoveryAdmission } from "../services/agent-provider-cooldown.ts";
import { environmentService } from "../services/environments.ts";
import { releaseRunClaimedJustBeforeSuppression } from "../services/heartbeat-queued-claim-release.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("shared Codex account HTTP429 admission", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;
  let providerTurns = 0;
  let providerBarrier: Promise<void> | null = null;
  let providerHttpStatus: number | null = null;
  let runtimeCreations = 0;
  const services: ReturnType<typeof heartbeatService>[] = [];
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-account-throttle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    services.push(heartbeat);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-account-throttle-"));
    const execute = createCodexAcpExecutor({
      createRuntime: () => { runtimeCreations++; return ({
        ensureSession: async () => ({ backendSessionId: randomUUID(), agentSessionId: randomUUID(), runtimeSessionName: randomUUID() }),
        startTurn: () => {
          providerTurns++;
          const barrier = providerBarrier;
          const status = providerHttpStatus;
          return { events: (async function* () { await barrier; yield { type: "done", stopReason: status ? "failed" : "end_turn" }; })(), result: (async () => { await barrier; return status ? { status: "failed", error: { message: "Synthetic provider HTTP failure", providerHttpStatus: status } } : { status: "completed", stopReason: "end_turn" }; })(), cancel: async () => {} };
        },
        close: async () => {},
      }) as never; },
    });
    registerServerAdapter({ type: "codex_local", execute: async (ctx) => {
      const result = await execute(ctx);
      return { ...result, resultJson: { ...result.resultJson, conversationContinuation: "continue_conversation_v1" } };
    },
      testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
  }, 30_000);
  afterAll(async () => {
    for (const service of services) await service.drainActiveRunExecutions();
    unregisterServerAdapter("codex_local");
    await fs.rm(root, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedWorkers(count: number, accountId = "synthetic-shared-subscription") {
    const companyId = randomUUID();
    const providerAccountKey = createCodexProviderAccountKey(companyId, accountId);
    const prefix = `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Synthetic account throttle", issuePrefix: prefix, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await environmentService(db).ensureLocalEnvironment(companyId);
    const candidates: { agentId: string; issueId: string; home: string }[] = [];
    for (let i = 0; i < count; i++) {
      const agentId = randomUUID();
      const issueId = randomUUID();
      const home = path.join(root, agentId);
      await fs.mkdir(home);
      await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: { account_id: accountId, access_token: "synthetic-not-a-provider-credential" } }), { mode: 0o600 });
      await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic worker", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: { agentCommand: "node ./synthetic-acp.js", stateDir: path.join(root, "state", agentId), env: { CODEX_HOME: home, OPENAI_API_KEY: "" } }, permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
      await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic retained obligation", status: "in_progress", priority: "medium", responsibleUserId: "responsible-user", assigneeAgentId: agentId, issueNumber: i + 1, identifier: `${prefix}-${i + 1}` });
      candidates.push({ agentId, issueId, home });
    }
    return { companyId, providerAccountKey, candidates };
  }
  const wake = (service: typeof heartbeat, candidate: { agentId: string; issueId: string }) => service.wakeup(candidate.agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId: candidate.issueId }, requestedByActorType: "user", requestedByActorId: "local-board" });

  it("keeps six homes behind a durable wait, then admits one ordinary probe across concurrent service instances", async () => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(6);
    // The adapter's trusted structured status and selected account are persisted
    // dispatch evidence, independent of diagnostic text or a home-path guess.
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: candidates[0].agentId, status: "failed", startedAt: new Date(Date.now() - 2000), finishedAt: new Date(Date.now() - 1000), errorCode: "codex_transient_upstream", resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: new Date(Date.now() + 60_000).toISOString() }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local", providerAccountKey } } }).returning();
    const turnsBefore = providerTurns;
    const wakes = await Promise.all(candidates.map(candidate => wake(heartbeat, candidate)));
    await heartbeat.drainActiveRunExecutions();
    const rows = await Promise.all(wakes.map(wake => heartbeat.getRun(wake!.id)));
    expect(rows.map(row => row?.status)).toEqual(Array(6).fill("queued"));
    expect(rows.map(row => row?.activeIdentityContextId)).toEqual(Array(6).fill(null));
    expect(providerTurns - turnsBefore).toBe(0);
    expect(await db.select({ id: runIdentityContexts.id }).from(runIdentityContexts).where(eq(runIdentityContexts.companyId, companyId))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, candidates[0].issueId));
    expect(issue.status).toBe("in_progress");
    const restarted = heartbeatService(db);
    services.push(restarted);
    await restarted.resumeQueuedRuns();
    await restarted.drainActiveRunExecutions();
    expect(providerTurns - turnsBefore).toBe(0);
    // A success from a turn that was already in flight cannot clear the wait.
    await db.insert(heartbeatRuns).values({ companyId, agentId: candidates[1].agentId, status: "succeeded", startedAt: new Date(source.startedAt!.getTime() - 1000), finishedAt: new Date(), runnerProfileJson: { adapterDispatch: { providerAccountKey } } });
    await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson, retryNotBefore: new Date(Date.now() - 1000).toISOString() } }).where(eq(heartbeatRuns.id, source.id));
    let release!: () => void;
    providerBarrier = new Promise<void>(resolve => { release = resolve; });
    try {
      await Promise.all([heartbeat.resumeQueuedRuns(), restarted.resumeQueuedRuns()]);
      await expect.poll(() => providerTurns - turnsBefore, { timeout: 10_000 }).toBe(1);
      const running = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
      expect(running).toHaveLength(1);
      expect(running[0].runnerProfileJson).toMatchObject({ adapterDispatch: { providerAccountKey, providerAccountRecoveryOf: source.id } });
      await Promise.all([heartbeat.resumeQueuedRuns(), restarted.resumeQueuedRuns()]);
      expect(providerTurns - turnsBefore).toBe(1);
      await db.update(issues).set({ status: "done" }).where(eq(issues.companyId, companyId));
      release();
      await restarted.drainActiveRunExecutions();
      const recovered = await heartbeat.getRun(running[0].id);
      expect(recovered?.status).toBe("succeeded");
      expect(await providerAccountRecoveryAdmission(db, companyId, providerAccountKey, randomUUID())).toMatchObject({ allowed: true, recoveryOf: null });
    } finally { release(); providerBarrier = null; }
  }, 30_000);

  it("persists one bounded fallback on an actual structured429 outcome and holds another agent", async () => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(2);
    providerHttpStatus = 429;
    try {
      const run = await wake(heartbeat, candidates[0]);
      await heartbeat.drainActiveRunExecutions();
      const failed = await heartbeat.getRun(run!.id);
      expect(failed?.status).toBe("failed");
      expect(failed?.runnerProfileJson).toMatchObject({ adapterDispatch: { providerAccountKey } });
      expect(failed?.resultJson).toMatchObject({ providerHttpStatus: 429, errorFamily: "transient_upstream", providerAccountWaitSource: "bounded_retry" });
      const due = new Date(String(failed?.resultJson?.retryNotBefore));
      expect(due.getTime()).toBeGreaterThan(failed!.finishedAt!.getTime());
      const before = providerTurns;
      const other = await wake(heartbeat, candidates[1]);
      await heartbeat.drainActiveRunExecutions();
      expect(await heartbeat.getRun(other!.id)).toMatchObject({ status: "queued", activeIdentityContextId: null });
      expect(providerTurns).toBe(before);
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      expect(retry.scheduledRetryAt!.getTime()).toBe(due.getTime());
      expect(await providerAccountRecoveryAdmission(db, companyId, providerAccountKey, randomUUID())).toMatchObject({ allowed: false });
      expect(await providerAccountRecoveryAdmission(db, randomUUID(), providerAccountKey, randomUUID())).toMatchObject({ allowed: true });
      expect(await providerAccountRecoveryAdmission(db, companyId, createCodexProviderAccountKey(companyId, "different-account"), randomUUID())).toMatchObject({ allowed: true });
    } finally { providerHttpStatus = null; }
  }, 30_000);

  it("clears a claimed account/probe stamp when actual prepared authentication becomes ungrouped", async () => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(1, "prior-account");
    const candidate = candidates[0];
    await db.insert(heartbeatRuns).values({ companyId, agentId: candidate.agentId, status: "failed", finishedAt: new Date(Date.now() - 2000), resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: new Date(Date.now() - 1000).toISOString() }, runnerProfileJson: { adapterDispatch: { providerAccountKey } } });
    const service = heartbeatService(db, {
      beforeLegacyAdapterDispatch: async () => { await fs.writeFile(path.join(candidate.home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-api-key" })); },
    });
    services.push(service);
    const run = await wake(service, candidate);
    await service.drainActiveRunExecutions();
    expect((await service.getRun(run!.id))?.runnerProfileJson).toMatchObject({ adapterDispatch: { providerAccountKey: null, providerAccountRecoveryOf: null } });
  }, 30_000);

  it("rechecks an account change in the prepared adapter and joins cleanup before returning its dispatching claim to queue", async () => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(1, "blocked-account");
    const candidate = candidates[0];
    await db.insert(heartbeatRuns).values({ companyId, agentId: candidate.agentId, status: "failed", finishedAt: new Date(), resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: new Date(Date.now() + 60_000).toISOString() }, runnerProfileJson: { adapterDispatch: { providerAccountKey } } });
    const authPath = path.join(candidate.home, "auth.json");
    await fs.writeFile(authPath, JSON.stringify({ tokens: { account_id: "available-account", access_token: "synthetic" } }));
    const cleanupObservations: string[] = [];
    const service = heartbeatService(db, {
      beforeLegacyAdapterDispatch: async () => { await fs.writeFile(authPath, JSON.stringify({ tokens: { account_id: "blocked-account", access_token: "synthetic" } })); },
      beforeProviderCooldownClaimRelease: async (runId) => {
        const current = await service.getRun(runId);
        expect(current).toMatchObject({ status: "running", executionStage: "dispatching", processPid: null });
        cleanupObservations.push(current!.status);
        await service.resumeQueuedRuns();
        cleanupObservations.push((await service.getRun(runId))!.status);
      },
    });
    services.push(service);
    const before = runtimeCreations;
    const run = await wake(service, candidate);
    await service.drainActiveRunExecutions();
    expect(runtimeCreations).toBe(before);
    expect(cleanupObservations).toEqual(["running", "running"]);
    expect(await service.getRun(run!.id)).toMatchObject({ status: "queued", startedAt: null, activeIdentityContextId: null, errorCode: null });
    const [issue] = await db.select().from(issues).where(eq(issues.id, candidate.issueId));
    expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: candidate.agentId, executionRunId: null });
  }, 30_000);

  it.each([
    { family: "transient_upstream", status: 503 },
    { family: "auth_missing", status: 429 },
    { family: "provider_quota", status: 429 },
    { family: "transient_upstream", status: "429" },
    { family: "transient_upstream", status: undefined },
  ])("does not create account backpressure from non-throttle evidence $family/$status", async ({ family, status }) => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(1);
    await db.insert(heartbeatRuns).values({ companyId, agentId: candidates[0].agentId, status: "failed", error: "Untrusted quoted 429 Too Many Requests", finishedAt: new Date(), resultJson: { errorFamily: family, providerHttpStatus: status, retryNotBefore: new Date(Date.now() + 60_000).toISOString() }, runnerProfileJson: { adapterDispatch: { providerAccountKey } } });
    expect(await providerAccountRecoveryAdmission(db, companyId, providerAccountKey, randomUUID())).toMatchObject({ allowed: true, recoveryOf: null });
  });

  it.each(["processGroupId", "processStartedAt"] as const)("refuses a pretransport release with retained %s ownership evidence", async (field) => {
    const { companyId, candidates } = await seedWorkers(1);
    const controllerBootId = randomUUID();
    const identityId = randomUUID();
    const lease = new Date(Date.now() + 60_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: candidates[0].agentId,
      status: "running", executionStage: "dispatching", controllerBootId, controllerLeaseExpiresAt: lease,
      activeIdentityContextId: identityId, startedAt: new Date(), processPid: null,
      processGroupId: field === "processGroupId" ? 12345 : null,
      processStartedAt: field === "processStartedAt" ? new Date() : null,
      contextSnapshot: { issueId: candidates[0].issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, candidates[0].issueId));
    await releaseRunClaimedJustBeforeSuppression(db, run.id, controllerBootId, { adapterPreparationOnly: true });
    expect(await heartbeat.getRun(run.id)).toMatchObject({ status: "running", activeIdentityContextId: identityId, controllerBootId, controllerLeaseExpiresAt: lease });
    const [issue] = await db.select().from(issues).where(eq(issues.id, candidates[0].issueId));
    expect(issue.executionRunId).toBe(run.id);
    // These rows model retained ownership only; no executor or process exists.
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
  });

  it("linearizes a new probe429 outcome with admission after reading an older expired source", async () => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(2);
    await db.insert(heartbeatRuns).values({ companyId, agentId: candidates[0].agentId, status: "failed", finishedAt: new Date(Date.now() - 2000), resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: new Date(Date.now() - 1000).toISOString() }, runnerProfileJson: { adapterDispatch: { providerAccountKey } } });
    let release!: () => void;
    providerBarrier = new Promise<void>(resolve => { release = resolve; });
    providerHttpStatus = 429;
    const before = providerTurns;
    const probe = await wake(heartbeat, candidates[0]);
    await expect.poll(() => providerTurns - before, { timeout: 10_000 }).toBe(1);
    try {
      const admission = await db.transaction(async tx => {
        await lockProviderAccountAdmission(tx, companyId, providerAccountKey);
        return providerAccountRecoveryAdmission(tx, companyId, providerAccountKey, randomUUID(), new Date(), {
          afterSourceRead: async () => {
            release();
            // A source writer must either finish (old unlocked implementation),
            // or wait on our advisory lock (fixed). Neither depends on a sleep.
            await expect.poll(async () => {
              const current = await heartbeat.getRun(probe!.id);
              const waiting = await db.execute(sql`select exists(select 1 from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())) as waiting`);
              return current?.status === "failed" || Boolean(waiting[0]?.waiting);
            }, { timeout: 10_000 }).toBe(true);
          },
        });
      });
      expect(admission.allowed).toBe(false);
      await heartbeat.drainActiveRunExecutions();
      expect(await heartbeat.getRun(probe!.id)).toMatchObject({ status: "failed" });
      expect(await providerAccountRecoveryAdmission(db, companyId, providerAccountKey, randomUUID())).toMatchObject({ allowed: false });
    } finally { release(); providerBarrier = null; providerHttpStatus = null; }
  }, 30_000);
});

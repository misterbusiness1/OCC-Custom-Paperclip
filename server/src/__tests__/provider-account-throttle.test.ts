import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClaudeAcpExecutor } from "@paperclipai/adapter-claude-local/server";
import { createCodexAcpExecutor, createCodexProviderAccountKey } from "@paperclipai/adapter-codex-local/server";
import { agents, companies, createDb, heartbeatRuns, issues, runIdentityContexts } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { lockProviderAdmission, providerRecoveryAdmission } from "../services/agent-provider-cooldown.ts";
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
  const turnsByAgent = new Map<string, number>();
  let providerBarrier: Promise<void> | null = null;
  let providerHttpStatus: number | null = null;
  let providerRetryHint: string | null = null;
  let retainConversationPolicy = true;
  let runtimeCreations = 0;
  const services: ReturnType<typeof heartbeatService>[] = [];
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-account-throttle-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    services.push(heartbeat);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-account-throttle-"));
    const runtimeOptions: NonNullable<Parameters<typeof createCodexAcpExecutor>[0]> = {
      createRuntime: (options) => { const agentId = String(options.terminalEnv?.PAPERCLIP_AGENT_ID); runtimeCreations++; return ({
        ensureSession: async () => ({ backendSessionId: randomUUID(), agentSessionId: randomUUID(), runtimeSessionName: randomUUID() }),
        startTurn: () => {
          providerTurns++;
          turnsByAgent.set(agentId, (turnsByAgent.get(agentId) ?? 0) + 1);
          const barrier = providerBarrier;
          const status = providerHttpStatus;
          return { events: (async function* () { await barrier; yield { type: "done", stopReason: status ? "failed" : "end_turn" }; })(), result: (async () => { await barrier; return status ? { status: "failed", error: { message: "Synthetic provider HTTP failure", providerHttpStatus: status } } : { status: "completed", stopReason: "end_turn" }; })(), cancel: async () => {} };
        },
        close: async () => {},
      }) as never; },
    };
    for (const { type, execute } of [
      { type: "codex_local", execute: createCodexAcpExecutor(runtimeOptions) },
      { type: "claude_local", execute: createClaudeAcpExecutor(runtimeOptions) },
    ] as const) registerServerAdapter({ type, execute: async (ctx) => {
      const hint = providerRetryHint;
      const result = await execute(ctx);
      return { ...result, ...(hint ? { retryNotBefore: hint } : {}),
        resultJson: { ...result.resultJson, ...(retainConversationPolicy ? { conversationContinuation: "continue_conversation_v1" } : {}) } };
    }, testEnvironment: async () => ({ adapterType: type, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
  }, 30_000);
  afterEach(async () => {
    for (const service of services) await service.drainActiveRunExecutions();
    // Queue scans are instance-wide. Remove earlier synthetic lineages so a
    // 30-second retry cannot re-enter a later test with its provider fixture.
    await db.execute(sql`truncate table companies cascade`);
    providerHttpStatus = null; providerRetryHint = null; retainConversationPolicy = true;
  });
  afterAll(async () => {
    for (const service of services) await service.drainActiveRunExecutions();
    unregisterServerAdapter("codex_local");
    unregisterServerAdapter("claude_local");
    await fs.rm(root, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedWorkers(count: number, accountId = "synthetic-shared-subscription", adapterType: "codex_local" | "claude_local" = "codex_local") {
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
      await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic worker", role: "engineer", status: "idle", adapterType, adapterConfig: { agentCommand: "node ./synthetic-acp.js", stateDir: path.join(root, "state", agentId), env: { CODEX_HOME: home, OPENAI_API_KEY: "" } }, permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
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
      expect(await providerRecoveryAdmission(db, companyId, { kind: "account", providerAccountKey }, randomUUID())).toMatchObject({ allowed: true, recoveryOf: null });
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
      expect(await providerRecoveryAdmission(db, companyId, { kind: "account", providerAccountKey }, randomUUID())).toMatchObject({ allowed: false });
      expect(await providerRecoveryAdmission(db, randomUUID(), { kind: "account", providerAccountKey }, randomUUID())).toMatchObject({ allowed: true });
      expect(await providerRecoveryAdmission(db, companyId, { kind: "account", providerAccountKey: createCodexProviderAccountKey(companyId, "different-account") }, randomUUID())).toMatchObject({ allowed: true });
    } finally { providerHttpStatus = null; }
  }, 30_000);

  it.each((["codex_local", "claude_local"] as const).flatMap(adapterType =>
    (["assignment", "comment", "manual"] as const).map(reason => ({ adapterType, reason }))))(
    "holds independent $adapterType $reason work on the same API route behind its persisted 429 retry wait", async ({ adapterType, reason }) => {
    const { candidates } = await seedWorkers(2, "synthetic-shared-subscription", adapterType);
    const candidate = candidates[0];
    await db.update(agents).set({ adapterConfig: {
      agentCommand: "node ./synthetic-acp.js",
      stateDir: path.join(root, "state", candidate.agentId),
      env: { CODEX_HOME: candidate.home, CLAUDE_CONFIG_DIR: path.join(candidate.home, "claude"),
        ...(adapterType === "codex_local" ? { OPENAI_API_KEY: "synthetic-api-key" } : { ANTHROPIC_API_KEY: "synthetic-api-key" }) },
    } }).where(eq(agents.id, candidate.agentId));
    await db.update(issues).set({ assigneeAgentId: candidate.agentId }).where(eq(issues.id, candidates[1].issueId));
    providerHttpStatus = 429;
    try {
      const source = await wake(heartbeat, candidate);
      await heartbeat.drainActiveRunExecutions();
      const failed = await heartbeat.getRun(source!.id);
      expect(failed).toMatchObject({ status: "failed", resultJson: { providerHttpStatus: 429, errorFamily: "transient_upstream" }, runnerProfileJson: { adapterDispatch: { providerAccountKey: null } } });
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source!.id));
      expect(retry.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now());
      const before = providerTurns;
      expect(failed?.runnerProfileJson).toMatchObject({ adapterDispatch: { providerAdmissionScopeKind: "provider_route", providerAccountRecoveryOf: null } });
      expect(failed?.resultJson).toMatchObject({ providerAdmissionWaitSource: "bounded_retry" });
      expect(new Date(String(failed?.resultJson?.retryNotBefore)).getTime()).toBe(retry.scheduledRetryAt!.getTime());
      const next = await heartbeat.wakeup(candidate.agentId, {
        source: reason === "assignment" ? "assignment" : reason === "manual" ? "on_demand" : "automation",
        triggerDetail: reason === "manual" ? "manual" : "system",
        reason: reason === "assignment" ? "issue_assigned" : reason === "manual" ? "manual" : "issue_commented",
        payload: { issueId: candidates[1].issueId },
        ...(reason === "manual" ? { contextSnapshot: { forceFreshSession: true } } : {}),
        requestedByActorType: "user", requestedByActorId: reason === "manual" ? "responsible-user" : "local-board",
      });
      await heartbeat.drainActiveRunExecutions();
      expect(await heartbeat.getRun(next!.id)).toMatchObject({ status: "queued", activeIdentityContextId: null });
      expect(providerTurns).toBe(before);
    } finally { providerHttpStatus = null; }
  }, 30_000);

  it.each([
    { hint: "past", delay: -60_000, attempt: 0 },
    { hint: "short", delay: 1_000, attempt: 0 },
    { hint: "long", delay: 120_000, attempt: 0 },
    { hint: "exhausted", delay: null, attempt: 2 },
  ])("canonicalizes $hint API-route429 timing with the existing bounded authority", async ({ delay, attempt }) => {
    const { companyId, candidates } = await seedWorkers(1);
    const candidate = candidates[0];
    await db.update(agents).set({ adapterConfig: { agentCommand: "node ./synthetic-acp.js", stateDir: path.join(root, "state", candidate.agentId),
      env: { CODEX_HOME: candidate.home, OPENAI_API_KEY: "synthetic-api-key" } } }).where(eq(agents.id, candidate.agentId));
    providerHttpStatus = 429;
    const hint = delay == null ? null : new Date(Date.now() + delay).toISOString(); providerRetryHint = hint;
    try {
      let runId = (await wake(heartbeat, candidate))!.id;
      for (let used = 0; used < attempt; used++) {
        await heartbeat.drainActiveRunExecutions();
        const previous = (await heartbeat.getRun(runId))!;
        expect(previous.scheduledRetryAttempt).toBe(used);
        const [child] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
        expect(previous).toMatchObject({ status: "failed", resultJson: { providerHttpStatus: 429, errorFamily: "transient_upstream" } });
        expect(child).toBeDefined();
        expect(child.scheduledRetryAttempt).toBe(used + 1);
        const past = new Date(Date.now() - 1000);
        await db.update(heartbeatRuns).set({ resultJson: { ...previous.resultJson,
          retryNotBefore: past.toISOString(), transientRetryNotBefore: past.toISOString() } }).where(eq(heartbeatRuns.id, runId));
        await db.update(heartbeatRuns).set({ scheduledRetryAt: past }).where(eq(heartbeatRuns.id, child.id));
        runId = child.id;
        await heartbeat.promoteDueScheduledRetries();
        expect(await heartbeat.getRun(runId)).toMatchObject({ status: "queued" });
        await heartbeat.resumeQueuedRuns();
      }
      await heartbeat.drainActiveRunExecutions();
      const failed = (await heartbeat.getRun(runId))!;
      expect(failed).toMatchObject({ status: "failed", scheduledRetryAttempt: attempt, resultJson: { providerHttpStatus: 429, errorFamily: "transient_upstream", providerAdmissionWaitSource: "bounded_retry" } });
      const canonical = new Date(String(failed.resultJson?.retryNotBefore)).getTime();
      expect(failed.resultJson?.transientRetryNotBefore).toBe(failed.resultJson?.retryNotBefore);
      expect(canonical).toBeGreaterThanOrEqual(failed.finishedAt!.getTime() + 30_000);
      if (delay === 120_000) expect(failed.resultJson?.retryNotBefore).toBe(hint);
      const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      expect(children).toHaveLength(attempt === 2 ? 0 : 1);
      if (children[0]) expect(children[0].scheduledRetryAt!.getTime()).toBe(canonical);
      expect(failed.resultJson).not.toHaveProperty("providerAccountWaitSource");
    } finally { providerHttpStatus = null; providerRetryHint = null; }
  }, 30_000);

  it("shares a null-account wait across agents on the same sampled provider route without crossing routes", async () => {
    const { companyId, candidates } = await seedWorkers(2);
    const scope = { kind: "provider_route" as const, agentId: candidates[0].agentId, providerCooldownKey: "synthetic-provider-scope" };
    const profile = { adapterDispatch: { providerAccountKey: null, providerCooldownKey: scope.providerCooldownKey } };
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: scope.agentId,
      status: "failed", finishedAt: new Date(), runnerProfileJson: profile,
      resultJson: { providerHttpStatus: 429, errorFamily: "transient_upstream" },
    }).returning();
    // Actual old null-account rows did not carry a source deadline. Their
    // persisted bounded successor is the authority, never a fresh invented wait.
    const dueAt = new Date(Date.now() + 60_000);
    await db.insert(heartbeatRuns).values({ companyId, agentId: scope.agentId, status: "queued",
      retryOfRunId: source.id, scheduledRetryAt: dueAt, scheduledRetryAttempt: 1 });
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID())).toMatchObject({ allowed: false, retryAt: dueAt });
    await db.update(heartbeatRuns).set({ resultJson: { providerHttpStatus: 429, errorFamily: "transient_upstream", retryNotBefore: "invalid-runtime-date" } }).where(eq(heartbeatRuns.id, source.id));
    await db.insert(heartbeatRuns).values({ companyId, agentId: scope.agentId, status: "failed", finishedAt: new Date(), runnerProfileJson: profile,
      resultJson: { providerHttpStatus: 429, errorFamily: "transient_upstream" } });
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID())).toMatchObject({ allowed: false, retryAt: dueAt, recoveryOf: source.id });
    expect(await providerRecoveryAdmission(db, randomUUID(), scope, randomUUID())).toMatchObject({ allowed: true });
    expect(await providerRecoveryAdmission(db, companyId, { ...scope, agentId: candidates[1].agentId }, randomUUID())).toMatchObject({ allowed: false, retryAt: dueAt });
    expect(await providerRecoveryAdmission(db, companyId, { ...scope, providerCooldownKey: "changed-auth-route" }, randomUUID())).toMatchObject({ allowed: true });
    expect(await providerRecoveryAdmission(db, companyId, { kind: "account", providerAccountKey: "explicit-new-subscription" }, randomUUID())).toMatchObject({ allowed: true });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { providerCooldownKey: scope.providerCooldownKey } } }).where(eq(heartbeatRuns.id, source.id));
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID())).toMatchObject({ allowed: true });
  });

  it("suppresses two agents after concurrent no-deadline429s on one unknown route and keeps the strongest retry deadline", async () => {
    const { companyId, candidates } = await seedWorkers(2);
    const providerCooldownKey = "synthetic-shared-unknown-route";
    const dispatch = { providerAccountKey: null, providerCooldownKey };
    const finishedAt = new Date();
    const failures = await db.insert(heartbeatRuns).values(candidates.map((candidate) => ({
      companyId,
      agentId: candidate.agentId,
      status: "failed" as const,
      finishedAt,
      runnerProfileJson: { adapterDispatch: dispatch },
      resultJson: { providerHttpStatus: 429, errorFamily: "transient_upstream" },
    }))).returning();
    const shortDue = new Date(finishedAt.getTime() + 30_000);
    const longDue = new Date(finishedAt.getTime() + 120_000);
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: candidates[0].agentId, status: "queued", retryOfRunId: failures[0].id,
        scheduledRetryAt: shortDue, scheduledRetryAttempt: 1 },
      { companyId, agentId: candidates[1].agentId, status: "queued", retryOfRunId: failures[1].id,
        scheduledRetryAt: longDue, scheduledRetryAttempt: 1 },
    ]);
    const admissions = await Promise.all(candidates.map((candidate) => providerRecoveryAdmission(db, companyId,
      { kind: "provider_route", agentId: candidate.agentId, providerCooldownKey }, randomUUID(), finishedAt)));
    expect(admissions).toEqual([
      { allowed: false, recoveryOf: failures[1].id, retryAt: longDue },
      { allowed: false, recoveryOf: failures[1].id, retryAt: longDue },
    ]);
    expect(await providerRecoveryAdmission(db, companyId,
      { kind: "provider_route", agentId: candidates[0].agentId, providerCooldownKey: "distinct-credential-route" },
      randomUUID(), finishedAt)).toEqual({ allowed: true, recoveryOf: null, retryAt: null });
  });

  it.each(["account", "provider_route"] as const)("keeps two in-flight $0 outcomes behind the longer persisted deadline", async (kind) => {
    const { companyId, candidates } = await seedWorkers(2); const candidate = candidates[0];
    if (kind === "provider_route") await db.update(agents).set({ adapterConfig: { agentCommand: "node ./synthetic-acp.js", stateDir: path.join(root, "state", candidate.agentId),
      env: { CODEX_HOME: candidate.home, OPENAI_API_KEY: "synthetic-api-key" } } }).where(eq(agents.id, candidate.agentId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } } }).where(eq(agents.id, candidate.agentId));
    await db.update(issues).set({ assigneeAgentId: candidate.agentId }).where(eq(issues.companyId, companyId));
    let releaseLong!: () => void; let releaseShort!: () => void;
    providerHttpStatus = 429; providerRetryHint = new Date(Date.now() + 120_000).toISOString();
    const longHint = providerRetryHint; providerBarrier = new Promise<void>(resolve => { releaseLong = resolve; });
    const before = turnsByAgent.get(candidate.agentId) ?? 0;
    const long = await wake(heartbeat, candidate);
    await expect.poll(() => turnsByAgent.get(candidate.agentId), { timeout: 10_000 }).toBe(before + 1);
    providerRetryHint = null; providerBarrier = new Promise<void>(resolve => { releaseShort = resolve; });
    const short = await wake(heartbeat, { ...candidate, issueId: candidates[1].issueId });
    await expect.poll(() => turnsByAgent.get(candidate.agentId), { timeout: 10_000 }).toBe(before + 2);
    try {
      releaseLong(); await expect.poll(async () => (await heartbeat.getRun(long!.id))?.status, { timeout: 10_000 }).toBe("failed");
      releaseShort(); await heartbeat.drainActiveRunExecutions();
      const first = (await heartbeat.getRun(long!.id))!; const second = (await heartbeat.getRun(short!.id))!;
      expect(first.resultJson?.retryNotBefore).toBe(longHint);
      expect(new Date(String(second.resultJson?.retryNotBefore)).getTime()).toBeLessThan(new Date(longHint).getTime());
      const [child] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, second.id));
      expect(child.scheduledRetryAt!.toISOString()).toBe(second.resultJson?.retryNotBefore);
      const dispatch = first.runnerProfileJson!.adapterDispatch as Record<string, unknown>;
      const scope: Parameters<typeof providerRecoveryAdmission>[2] = kind === "account"
        ? { kind, providerAccountKey: String(dispatch.providerAccountKey) }
        : { kind, agentId: candidate.agentId, providerCooldownKey: String(dispatch.providerCooldownKey) };
      expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID())).toMatchObject({ allowed: false, recoveryOf: first.id, retryAt: new Date(longHint) });
    } finally { releaseLong(); releaseShort(); providerBarrier = null; providerHttpStatus = null; providerRetryHint = null; }
  }, 30_000);

  it.each((["account", "provider_route"] as const).flatMap(kind =>
    (["ordered", "reversed", "tied"] as const).map(order => ({ kind, order }))))(
    "honors the strongest $kind deadline with $order failure timestamps", async ({ kind, order }) => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(1);
    const agentId = candidates[0].agentId;
    const scope: Parameters<typeof providerRecoveryAdmission>[2] = kind === "account" ? { kind, providerAccountKey }
      : { kind, agentId, providerCooldownKey: "synthetic-provider-scope" };
    const dispatch = { providerAccountKey: kind === "account" ? providerAccountKey : null, providerCooldownKey: "synthetic-provider-scope" };
    const now = new Date(); const longDue = new Date(now.getTime() + 120_000); const shortDue = new Date(now.getTime() + 30_000);
    const [short] = await db.insert(heartbeatRuns).values({ id: "00000000-0000-4000-8000-000000000002", companyId, agentId, status: "failed", finishedAt: now,
      runnerProfileJson: { adapterDispatch: dispatch }, resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: shortDue.toISOString() } }).returning();
    const [long] = await db.insert(heartbeatRuns).values({ id: "00000000-0000-4000-8000-000000000001", companyId, agentId, status: "failed",
      finishedAt: new Date(now.getTime() + (order === "ordered" ? 1 : order === "reversed" ? -1 : 0)),
      runnerProfileJson: { adapterDispatch: dispatch }, resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: longDue.toISOString() } }).returning();
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID(), now)).toMatchObject({ allowed: false, retryAt: longDue, recoveryOf: long.id });
    const field = kind === "account" ? "providerAccountRecoveryOf" : "providerAgentRecoveryOf";
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", startedAt: new Date(shortDue.getTime() + 1), finishedAt: new Date(shortDue.getTime() + 2),
      runnerProfileJson: { adapterDispatch: { ...dispatch, [field]: short.id } } });
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID(), new Date(shortDue.getTime() + 3))).toMatchObject({ allowed: false, recoveryOf: long.id });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", startedAt: new Date(longDue.getTime() + 1), finishedAt: new Date(longDue.getTime() + 2),
      runnerProfileJson: { adapterDispatch: { ...dispatch, [field]: long.id } } });
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID(), new Date(longDue.getTime() + 3))).toMatchObject({ allowed: true, recoveryOf: null });
    const nextDue = new Date(longDue.getTime() + 60_000);
    const [nextFailure] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", finishedAt: new Date(longDue.getTime() + 4),
      runnerProfileJson: { adapterDispatch: dispatch }, resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: nextDue.toISOString() } }).returning();
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID(), new Date(longDue.getTime() + 5))).toMatchObject({ allowed: false, recoveryOf: nextFailure.id, retryAt: nextDue });
  });

  it("admits one causal null-account probe across services and restart without accepting old/reset successes", async () => {
    const { companyId, candidates } = await seedWorkers(3);
    const candidate = candidates[0];
    await db.update(agents).set({ adapterConfig: { agentCommand: "node ./synthetic-acp.js", stateDir: path.join(root, "state", candidate.agentId),
      env: { CODEX_HOME: candidate.home, OPENAI_API_KEY: "synthetic-api-key" } },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } },
    }).where(eq(agents.id, candidate.agentId));
    await db.update(issues).set({ assigneeAgentId: candidate.agentId }).where(eq(issues.companyId, companyId));
    providerHttpStatus = 429;
    const sourceRun = await wake(heartbeat, candidate);
    await heartbeat.drainActiveRunExecutions();
    providerHttpStatus = null;
    const source = (await heartbeat.getRun(sourceRun!.id))!;
    const dispatch = source.runnerProfileJson!.adapterDispatch as Record<string, unknown>;
    const scope = { kind: "provider_route" as const, agentId: candidate.agentId, providerCooldownKey: String(dispatch.providerCooldownKey) };
    const queued = await Promise.all(candidates.slice(1).map(c => wake(heartbeat, { ...candidate, issueId: c.issueId })));
    const restarted = heartbeatService(db); services.push(restarted);
    const turns = () => turnsByAgent.get(candidate.agentId) ?? 0;
    const before = turns();
    await restarted.resumeQueuedRuns(); await restarted.drainActiveRunExecutions();
    expect(turns()).toBe(before);
    expect(await heartbeat.getRun(queued[0]!.id)).toMatchObject({ status: "queued", activeIdentityContextId: null });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: candidate.agentId, status: "succeeded", startedAt: new Date(source.startedAt!.getTime() - 1000), finishedAt: new Date(), runnerProfileJson: source.runnerProfileJson },
      { companyId, agentId: candidate.agentId, status: "succeeded", startedAt: new Date(), finishedAt: new Date(),
        runnerProfileJson: { adapterDispatch: { ...dispatch, providerAgentRecoveryOf: source.id } }, resultJson: { conversationReset: true } },
    ]);
    expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID())).toMatchObject({ allowed: false });
    await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson, retryNotBefore: new Date(Date.now() - 1000).toISOString() } }).where(eq(heartbeatRuns.id, source.id));
    let release!: () => void; providerBarrier = new Promise<void>(resolve => { release = resolve; });
    let releasePreparation!: () => void;
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    let observedPreparation!: () => void;
    const observed = new Promise<void>(resolve => { observedPreparation = resolve; });
    let unpreparedRunId: string | null = null;
    const paused = heartbeatService(db, { beforeProviderScopePreparation: async (runId) => {
      const current = await heartbeat.getRun(runId);
      if (current?.companyId !== companyId) return;
      unpreparedRunId = runId; observedPreparation(); await preparation;
    } }); services.push(paused);
    try {
      await paused.resumeQueuedRuns(); await observed;
      // Claim receipts must already expose the one probe while its actual
      // preparation is paused, even with maxConcurrentRuns=3 and two services.
      expect((await heartbeat.getRun(unpreparedRunId!))?.runnerProfileJson).toMatchObject({ adapterDispatch: {
        providerCooldownKey: scope.providerCooldownKey, providerAdmissionScopeKind: "provider_route", providerAgentRecoveryOf: source.id,
      } });
      await restarted.resumeQueuedRuns();
      const unprepared = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
      expect(unprepared).toHaveLength(1); expect(turns()).toBe(before);
      releasePreparation();
      await expect.poll(() => turns() - before, { timeout: 10_000 }).toBe(1);
      const running = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
      expect(running).toHaveLength(1);
      expect(running[0].runnerProfileJson).toMatchObject({ adapterDispatch: { providerAdmissionScopeKind: "provider_route", providerAccountKey: null, providerAccountRecoveryOf: null, providerAgentRecoveryOf: source.id } });
      await Promise.all([heartbeat.resumeQueuedRuns(), restarted.resumeQueuedRuns()]); expect(turns()).toBe(before + 1);
      await db.update(issues).set({ status: "done" }).where(eq(issues.companyId, companyId));
      release(); await Promise.all([heartbeat.drainActiveRunExecutions(), restarted.drainActiveRunExecutions(), paused.drainActiveRunExecutions()]);
      expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID())).toMatchObject({ allowed: true, recoveryOf: null });
    } finally { releasePreparation(); release(); providerBarrier = null; providerHttpStatus = null; }
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
    expect((await service.getRun(run!.id))?.runnerProfileJson).toMatchObject({ adapterDispatch: { providerAdmissionScopeKind: "provider_route", providerAccountKey: null, providerAccountRecoveryOf: null, providerAgentRecoveryOf: null } });
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
    expect(await providerRecoveryAdmission(db, companyId, { kind: "account", providerAccountKey }, randomUUID())).toMatchObject({ allowed: true, recoveryOf: null });
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

  it.each(["account", "provider_route", "provider_route_legacy"] as const)("linearizes $0 probe429 with admission reading an older source", async (kind) => {
    const { companyId, providerAccountKey, candidates } = await seedWorkers(2);
    const candidate = candidates[0];
    let scope: Parameters<typeof providerRecoveryAdmission>[2] = { kind: "account", providerAccountKey };
    let probeCandidate = candidate;
    if (kind === "account") {
      await db.insert(heartbeatRuns).values({ companyId, agentId: candidate.agentId, status: "failed", finishedAt: new Date(Date.now() - 2000), resultJson: { errorFamily: "transient_upstream", providerHttpStatus: 429, retryNotBefore: new Date(Date.now() - 1000).toISOString() }, runnerProfileJson: { adapterDispatch: { providerAccountKey } } });
    } else {
      await db.update(agents).set({ adapterConfig: { agentCommand: "node ./synthetic-acp.js", stateDir: path.join(root, "state", candidate.agentId),
        env: { CODEX_HOME: candidate.home, OPENAI_API_KEY: "synthetic-api-key" } } }).where(eq(agents.id, candidate.agentId));
      await db.update(issues).set({ assigneeAgentId: candidate.agentId }).where(eq(issues.id, candidates[1].issueId));
      providerHttpStatus = 429;
      const initial = await wake(heartbeat, candidate); await heartbeat.drainActiveRunExecutions();
      const source = (await heartbeat.getRun(initial!.id))!;
      scope = { kind: "provider_route", agentId: candidate.agentId,
        providerCooldownKey: String((source.runnerProfileJson!.adapterDispatch as Record<string, unknown>).providerCooldownKey) };
      await db.update(heartbeatRuns).set({ resultJson: { ...source.resultJson, retryNotBefore: new Date(Date.now() - 1000).toISOString() } }).where(eq(heartbeatRuns.id, source.id));
      probeCandidate = { ...candidate, issueId: candidates[1].issueId };
    }
    let release!: () => void;
    providerBarrier = new Promise<void>(resolve => { release = resolve; });
    providerHttpStatus = 429; retainConversationPolicy = kind !== "provider_route_legacy";
    const turns = () => turnsByAgent.get(candidate.agentId) ?? 0; const before = turns();
    const probe = await wake(heartbeat, probeCandidate);
    await expect.poll(() => turns() - before, { timeout: 10_000 }).toBe(1);
    try {
      const admission = await db.transaction(async tx => {
        await lockProviderAdmission(tx, companyId, scope);
        const [reader] = await tx.execute(sql`select pg_backend_pid() as pid`);
        return providerRecoveryAdmission(tx, companyId, scope, randomUUID(), new Date(), {
          afterSourceRead: async () => {
            release();
            await expect.poll(async () => {
              const current = await heartbeat.getRun(probe!.id);
              const waiting = await db.execute(sql`select exists(select 1 from pg_locks waiting join pg_locks held on held.locktype=waiting.locktype and held.database=waiting.database and held.classid=waiting.classid and held.objid=waiting.objid and held.objsubid=waiting.objsubid where waiting.locktype='advisory' and not waiting.granted and held.granted and held.pid=${reader.pid}) as waiting`);
              return current?.status === "failed" || Boolean(waiting[0]?.waiting);
            }, { timeout: 10_000 }).toBe(true);
          },
        });
      });
      expect(admission.allowed).toBe(false);
      await heartbeat.drainActiveRunExecutions();
      expect(await heartbeat.getRun(probe!.id)).toMatchObject({ status: "failed" });
      expect(await providerRecoveryAdmission(db, companyId, scope, randomUUID())).toMatchObject({ allowed: false });
    } finally { release(); providerBarrier = null; providerHttpStatus = null; retainConversationPolicy = true; }
  }, 30_000);
});

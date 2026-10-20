import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexAcpExecutor } from "@paperclipai/adapter-codex-local/server";
import { agents, companies, createDb, heartbeatRuns, issues, environments, projects } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, heartbeatService } from "../services/heartbeat.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import { environmentService } from "../services/environments.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const adapterType = "credits_quota_integration_test";
const alternateAdapterType = "credits_quota_alternate_test";
// Beyond Codex's weekly horizon, so the adapter keeps the bounded fallback.
const fallbackResetSummary = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 8th, 2099 2:00 PM.";
let summary = fallbackResetSummary;

// Codex's format_retry_timestamp: process-local "%b %-d{suffix}, %Y %-I:%M %p".
function formatCodexReset(at: Date) {
  const day = at.getDate();
  const suffix = day >= 11 && day <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
  const month = at.toLocaleString("en-US", { month: "short" });
  const hour = at.getHours() % 12 || 12;
  const minute = String(at.getMinutes()).padStart(2, "0");
  return `${month} ${day}${suffix}, ${at.getFullYear()} ${hour}:${minute} ${at.getHours() < 12 ? "AM" : "PM"}`;
}

describeEmbedded("Codex ACP credits quota native retry", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;
  let providerTurns = 0;
  const adapterCallsByAgent = new Map<string, number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-credits-quota-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-credits-quota-provider-"));
    const execute = createCodexAcpExecutor({
      createRuntime: () => ({
        ensureSession: async (input: { sessionKey: string; cwd: string }) => ({
          sessionKey: input.sessionKey, cwd: input.cwd, backend: "acpx",
          runtimeSessionName: "synthetic-credits", acpxRecordId: "synthetic-record",
          backendSessionId: "synthetic-backend", agentSessionId: "synthetic-agent",
        }),
        startTurn: (input: { requestId: string }) => {
          providerTurns += 1;
          return {
            requestId: input.requestId,
            events: { async *[Symbol.asyncIterator]() {
              yield { type: "text_delta", text: summary, stream: "output", tag: "agent_message_chunk" };
            } },
            result: Promise.resolve({ status: "failed", error: { message: "Prompt failed" } }),
            cancel: async () => {}, closeStream: async () => {},
          };
        },
        getCapabilities: () => ({ controls: [] }),
        getStatus: async () => ({}), setConfigOption: async () => {},
        setMode: async () => {}, cancel: async () => {}, close: async () => {},
      }) as never,
    });
    const adapter: Parameters<typeof registerServerAdapter>[0] = {
      type: adapterType,
      execute: async (ctx) => {
        adapterCallsByAgent.set(ctx.agent.id, (adapterCallsByAgent.get(ctx.agent.id) ?? 0) + 1);
        const result = await execute({
          ...ctx,
          config: { ...ctx.config, engine: "acp", cwd: root, stateDir: path.join(root, "state"),
            env: { CODEX_HOME: path.join(root, "codex-home"), ...(ctx.config.env as Record<string, unknown> ?? {}) } },
        });
        // codex_local is a conversation adapter, whose failed runs the server
        // marks continue_conversation_v1. Upstream v2026.916.1 holds any other
        // failed legacy run for reconciliation instead of retrying it, so this
        // synthetic adapter type reports the same continuation contract.
        return {
          ...result,
          resultJson: { ...(result.resultJson ?? {}), conversationContinuation: "continue_conversation_v1" },
        };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    };
    registerServerAdapter(adapter);
    registerServerAdapter({ ...adapter, type: alternateAdapterType });
  }, 30_000);

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(adapterType);
    unregisterServerAdapter(alternateAdapterType);
    await tempDb?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function seedAssignedIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Synthetic credits retry", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Synthetic credits adapter", role: "engineer", status: "idle",
      adapterType, adapterConfig: { cwd: root }, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Synthetic retained obligation", status: "in_progress", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId,
      issueNumber: 1, identifier: `${prefix}-1`,
    });
    return { companyId, agentId, issueId };
  }

  it("persists the actual ACP classification and waits for one bounded retry without changing the issue", async () => {
    summary = fallbackResetSummary;
    const { agentId, issueId } = await seedAssignedIssue();
    const turnsBefore = providerTurns;
    const started = Date.now();
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(run).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 10_000 }).toBe("failed");
    const failed = await heartbeat.getRun(run!.id);
    expect(failed?.errorCode).toBe("provider_quota");
    expect(failed?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(failed?.resultJson).not.toHaveProperty("providerQuotaRetryNotBefore");
    expect(failed?.resultJson).not.toHaveProperty("transientRetryNotBefore");

    const readRetries = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    await expect.poll(async () => (await readRetries()).length, { timeout: 10_000 }).toBe(1);
    const [retry] = await readRetries();
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure" });
    expect(retry.contextSnapshot).toMatchObject({ issueId, errorFamily: "provider_quota" });
    const fallback = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0];
    const due = retry.scheduledRetryAt!.getTime();
    // Native scheduling uses its existing bounded jitter, not the ambiguous
    // provider wall-clock date. This range includes only the first delay tier.
    expect(due - started).toBeGreaterThanOrEqual(fallback * 0.75);
    expect(due - Date.now()).toBeLessThanOrEqual(fallback * 1.25);
    expect(await heartbeat.promoteDueScheduledRetries(new Date(due - 1))).toEqual({ promoted: 0, runIds: [] });
    expect(await heartbeat.promoteDueScheduledRetries(new Date(due - 1))).toEqual({ promoted: 0, runIds: [] });
    expect(await readRetries()).toHaveLength(1);
    expect(providerTurns - turnsBefore).toBe(1);
    const [retained] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(retained.status).toBe("in_progress");
    expect(retained.assigneeAgentId).toBe(agentId);
    expect(retained.executionRunId).toBe(retry.id);
    expect((await readRetries())[0].status).toBe("scheduled_retry");
  }, 30_000);

  async function failOnce(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(run).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 10_000 }).toBe("failed");
    const readRetries = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    await expect.poll(async () => (await readRetries()).length, { timeout: 10_000 }).toBe(1);
    return { failed: (await heartbeat.getRun(run!.id))!, retry: (await readRetries())[0] };
  }

  async function queueNewTask(
    companyId: string, agentId: string, issueNumber: number,
    assigneeAdapterOverrides?: { adapterConfig: Record<string, unknown> },
    projectId?: string,
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "New work during a provider wait",
      status: "todo", priority: "medium", responsibleUserId: "responsible-user",
      assigneeAgentId: agentId, issueNumber, assigneeAdapterOverrides, projectId,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-${issueNumber}`,
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(run).not.toBeNull();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    return { issueId, run: (await heartbeat.getRun(run!.id))! };
  }

  it("defers the first retry to a future provider reset behind Codex's skills warning", async () => {
    const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    reset.setSeconds(0, 0);
    const sentence = fallbackResetSummary.replace("Sep 8th, 2099 2:00 PM", formatCodexReset(reset));
    summary = `Warning: Exceeded skills context budget of 2%. All skill descriptions were removed and 108 additional skills were not included in the model-visible skills list.\n\n${sentence}`;
    const { agentId, issueId } = await seedAssignedIssue();
    const { failed, retry } = await failOnce(agentId, issueId);

    expect(failed.errorCode).toBe("provider_quota");
    expect(failed.error).toBe(sentence);
    // Codex prints whole minutes; the retry waits for the end of that minute.
    const retryAt = new Date(reset.getTime() + 60_000);
    expect(failed.resultJson).toMatchObject({
      errorFamily: "provider_quota",
      providerQuotaRetryNotBefore: retryAt.toISOString(),
    });
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(retry.scheduledRetryAt!.getTime()).toBe(retryAt.getTime());
    // Promotion is global; earlier tests' 30-second retries may be due by then.
    const promoted = await heartbeat.promoteDueScheduledRetries(new Date(reset.getTime() - 60_000));
    expect(promoted.runIds).not.toContain(retry.id);
    expect((await heartbeat.getRun(retry.id))?.status).toBe("scheduled_retry");
  }, 30_000);

  it("labels Codex's exhausted 429 as transient upstream with the bounded retry", async () => {
    summary = "exceeded retry limit, last status: 429 Too Many Requests";
    const { agentId, issueId } = await seedAssignedIssue();
    const started = Date.now();
    const { failed, retry } = await failOnce(agentId, issueId);

    expect(failed.errorCode).toBe("codex_transient_upstream");
    expect(failed.error).toBe(summary);
    expect(failed.resultJson).toMatchObject({ errorFamily: "transient_upstream" });
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure" });
    const fallback = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0];
    expect(retry.scheduledRetryAt!.getTime() - started).toBeGreaterThanOrEqual(fallback * 0.75);
    expect(retry.scheduledRetryAt!.getTime() - Date.now()).toBeLessThanOrEqual(fallback * 1.25);
  }, 30_000);

  it("keeps a new task queued while the same provider is waiting for its reset", async () => {
    const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    reset.setSeconds(0, 0);
    summary = fallbackResetSummary.replace("Sep 8th, 2099 2:00 PM", formatCodexReset(reset));
    const { companyId, agentId, issueId } = await seedAssignedIssue();
    const { failed } = await failOnce(agentId, issueId);
    await heartbeat.drainActiveRunExecutions();
    const next = await queueNewTask(companyId, agentId, 2);
    expect(adapterCallsByAgent.get(agentId)).toBe(1);
    expect(next.run.status).toBe("queued");
    const [retained] = await db.select().from(issues).where(eq(issues.id, next.issueId));
    expect(retained.status).toBe("todo");
    expect(retained.assigneeAgentId).toBe(agentId);

    // A later preparation failure did not reach the provider and cannot prove
    // that its quota recovered.
    await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "failed", finishedAt: new Date(),
      errorCode: "adapter_failed", error: "Workspace preparation failed",
      runnerProfileJson: failed.runnerProfileJson,
    });

    // A reset can complete alongside a failing provider turn; it did not
    // contact the provider and cannot clear that account's quota.
    await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "succeeded", finishedAt: new Date(),
      runnerProfileJson: failed.runnerProfileJson, resultJson: { conversationReset: true },
    });

    // A new service instance must preserve the same wait without sliding it.
    const restarted = heartbeatService(db);
    await restarted.resumeQueuedRuns();
    await restarted.drainActiveRunExecutions();
    expect(adapterCallsByAgent.get(agentId)).toBe(1);
    expect((await restarted.getRun(next.run.id))?.status).toBe("queued");

    // Model elapsed time in this disposable DB; do not change global timers
    // or ask the real provider to verify its quota. The next normal scan runs
    // the same queued task once its persisted wait has elapsed.
    const past = new Date(Date.now() - 60_000).toISOString();
    await db.update(heartbeatRuns).set({
      finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      error: "Provider quota exceeded for this model.",
      resultJson: { ...failed.resultJson, retryNotBefore: past,
        providerQuotaRetryNotBefore: past, transientRetryNotBefore: past },
    }).where(eq(heartbeatRuns.id, failed.id));
    await restarted.resumeQueuedRuns();
    await restarted.drainActiveRunExecutions();
    expect(adapterCallsByAgent.get(agentId)).toBe(2);
    expect((await restarted.getRun(next.run.id))?.status).toBe("failed");
  }, 30_000);

  it("holds at admission when an optional user secret has a value but no consumer declaration", async () => {
    summary = fallbackResetSummary;
    const { companyId, agentId, issueId } = await seedAssignedIssue();
    const secrets = secretService(db);
    const definition = await secrets.createUserSecretDefinition(companyId, {
      key: "optional-provider-account", name: "Synthetic optional account", provider: "local_encrypted",
    }, { userId: "responsible-user" });
    await secrets.createCurrentUserSecretValue(companyId, "responsible-user", {
      definitionId: definition.id, value: "synthetic-optional-account",
    }, { userId: "responsible-user" });
    await db.update(agents).set({ adapterConfig: { cwd: root, env: {
      OPTIONAL_SERVICE_TOKEN: { type: "user_secret_ref", key: definition.key, required: false },
    } } }).where(eq(agents.id, agentId));
    await failOnce(agentId, issueId);
    await heartbeat.drainActiveRunExecutions();
    const next = await queueNewTask(companyId, agentId, 2);
    expect(adapterCallsByAgent.get(agentId)).toBe(1);
    expect(next.run).toMatchObject({ status: "queued", startedAt: null, activeIdentityContextId: null });
  }, 30_000);

  it("rechecks the sampled provider when configuration changes back during claim", async () => {
    summary = fallbackResetSummary;
    const { companyId, agentId, issueId } = await seedAssignedIssue();
    await failOnce(agentId, issueId);
    await heartbeat.drainActiveRunExecutions();
    await db.update(agents).set({ adapterConfig: { cwd: root, env: { OPENAI_BASE_URL: "https://provider-b.invalid" } } }).where(eq(agents.id, agentId));
    const originalHeartbeat = heartbeat;
    let changed = false;
    const settledStatuses: Array<string | undefined> = [];
    heartbeat = heartbeatService(db, { beforeProviderCooldownClaimRelease: async (runId) => {
      settledStatuses.push((await heartbeat.getRun(runId))?.status);
      await heartbeat.resumeQueuedRuns();
      settledStatuses.push((await heartbeat.getRun(runId))?.status);
    }, beforeQueuedWakeClaim: async () => {
      changed = true;
      await db.update(agents).set({ adapterConfig: { cwd: root } }).where(eq(agents.id, agentId));
    } });
    try {
      const next = await queueNewTask(companyId, agentId, 2);
      expect(changed).toBe(true);
      expect(settledStatuses).toEqual(["running", "running"]);
      expect(adapterCallsByAgent.get(agentId)).toBe(1);
      expect(next.run).toMatchObject({ status: "queued", startedAt: null, errorCode: null });
      const [retained] = await db.select().from(issues).where(eq(issues.id, next.issueId));
      expect(retained.assigneeAgentId).toBe(agentId);
      expect(retained.executionRunId).toBeNull();
    } finally {
      heartbeat = originalHeartbeat;
    }
  }, 30_000);

  it.each(["default local environment", "project account"])(
    "permits a changed %s credential binding without inheriting the old wait",
    async (scope) => {
      summary = fallbackResetSummary;
      const { companyId, agentId, issueId } = await seedAssignedIssue();
      const envA = { OPENAI_API_KEY: { type: "plain" as const, value: "synthetic-account-a" } };
      const envB = { OPENAI_API_KEY: { type: "plain" as const, value: "synthetic-account-b" } };
      const local = await environmentService(db).ensureLocalEnvironment(companyId);
      const projectId = scope === "project account" ? randomUUID() : undefined;
      if (projectId) {
        await db.insert(projects).values({ id: projectId, companyId, name: "Synthetic provider routing", env: envA });
        await db.update(issues).set({ projectId }).where(eq(issues.id, issueId));
      } else {
        await db.update(environments).set({ envVars: envA }).where(eq(environments.id, local.id));
      }
      try {
        await failOnce(agentId, issueId);
        await heartbeat.drainActiveRunExecutions();
        if (projectId) await db.update(projects).set({ env: envB }).where(eq(projects.id, projectId));
        else await db.update(environments).set({ envVars: envB }).where(eq(environments.id, local.id));
        const next = await queueNewTask(companyId, agentId, 2, undefined, projectId);
        expect(adapterCallsByAgent.get(agentId)).toBe(2);
        expect(next.run.status).toBe("failed");
        if (projectId) await db.update(projects).set({ env: envA }).where(eq(projects.id, projectId));
        else await db.update(environments).set({ envVars: envA }).where(eq(environments.id, local.id));
        const original = await queueNewTask(companyId, agentId, 3, undefined, projectId);
        expect(adapterCallsByAgent.get(agentId)).toBe(2);
        expect(original.run.status).toBe("queued");
      } finally {
        if (!projectId) await db.update(environments).set({ envVars: local.envVars }).where(eq(environments.id, local.id));
      }
    }, 30_000,
  );

  it.each(["adapter", "agent provider", "issue provider"])(
    "permits a changed %s while retaining the old provider's cooldown",
    async (change) => {
      const reset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      reset.setSeconds(0, 0);
      summary = fallbackResetSummary.replace("Sep 8th, 2099 2:00 PM", formatCodexReset(reset));
      const { companyId, agentId, issueId } = await seedAssignedIssue();
      await failOnce(agentId, issueId);
      await heartbeat.drainActiveRunExecutions();
      const otherProvider = { env: { OPENAI_BASE_URL: "https://provider-b.invalid" } };
      if (change === "adapter") await db.update(agents).set({ adapterType: alternateAdapterType }).where(eq(agents.id, agentId));
      if (change === "agent provider") await db.update(agents).set({ adapterConfig: { cwd: root, ...otherProvider } }).where(eq(agents.id, agentId));
      const next = await queueNewTask(companyId, agentId, 2,
        change === "issue provider" ? { adapterConfig: otherProvider } : undefined);
      expect(adapterCallsByAgent.get(agentId)).toBe(2);
      expect(next.run.status).toBe("failed");

      await db.update(agents).set({ adapterType, adapterConfig: { cwd: root } }).where(eq(agents.id, agentId));
      const originalProvider = await queueNewTask(companyId, agentId, 3);
      expect(adapterCallsByAgent.get(agentId)).toBe(2);
      expect(originalProvider.run.status).toBe("queued");
    }, 30_000,
  );
});

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS } from "../services/recovery/service.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const adapterType = "generic_quota_integration_test";

// What each production lane returned before this fix: opencode_local's
// DeepSeek 402 as adapter_failed, the claude_local ACP lane as acpx_turn_failed.
let nextFailure: { errorCode: string; errorMessage: string } = {
  errorCode: "adapter_failed",
  errorMessage: "Insufficient Balance (request_id: dc4ac155-3f57-4b2b-98a3-63346b8c7d95)",
};
let providerTurns = 0;

describeEmbedded("generic adapter provider quota failures", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-generic-quota-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: adapterType,
      execute: async () => {
        providerTurns += 1;
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: nextFailure.errorCode,
          errorMessage: nextFailure.errorMessage,
          // The production lanes (opencode_local, the claude_local ACP lane)
          // are conversation adapters, whose failed runs the server marks
          // continue_conversation_v1. Upstream v2026.916.1 holds any other
          // failed legacy run for reconciliation instead of retrying it, so
          // this synthetic adapter reports the same continuation contract.
          resultJson: { stdout: "", stderr: "", conversationContinuation: "continue_conversation_v1" },
        };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(adapterType);
    await tempDb?.cleanup();
  });

  async function seedAssignedIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Synthetic quota retry", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Synthetic quota adapter", role: "engineer", status: "idle",
      adapterType, adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Synthetic retained obligation", status: "in_progress", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId,
      issueNumber: 1, identifier: `${prefix}-1`,
    });
    return { agentId, issueId };
  }

  async function runUntilFailed(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(run).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 10_000 }).toBe("failed");
    return run!.id;
  }

  it("classifies an opencode balance failure as provider_quota and defers the retry by the default backoff", async () => {
    nextFailure = {
      errorCode: "adapter_failed",
      errorMessage: "Insufficient Balance (request_id: dc4ac155-3f57-4b2b-98a3-63346b8c7d95)",
    };
    const turnsBefore = providerTurns;
    const { agentId, issueId } = await seedAssignedIssue();
    const started = Date.now();
    const runId = await runUntilFailed(agentId, issueId);

    const failed = await heartbeat.getRun(runId);
    expect(failed?.errorCode).toBe("provider_quota");
    expect(failed?.resultJson).toMatchObject({
      errorFamily: "provider_quota",
      providerQuotaKind: "balance_exhausted",
      providerQuotaResetSource: "default",
      originalErrorCode: "adapter_failed",
    });

    const readRetries = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    await expect.poll(async () => (await readRetries()).length, { timeout: 10_000 }).toBe(1);
    const [retry] = await readRetries();
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(retry.contextSnapshot).toMatchObject({ issueId, errorFamily: "provider_quota" });
    // Deferred by the provider_quota default, not the 2-minute transient tier.
    expect(retry.scheduledRetryAt!.getTime() - started).toBeGreaterThanOrEqual(PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS);
    expect(await heartbeat.promoteDueScheduledRetries(new Date(started + 5 * 60 * 1000))).toEqual({ promoted: 0, runIds: [] });
    expect(providerTurns - turnsBefore).toBe(1);

    const [retained] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(retained.status).toBe("in_progress");
    expect(retained.assigneeAgentId).toBe(agentId);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent.status).not.toBe("error");
  }, 30_000);

  it("defers a claude ACP session-limit failure to the provider reset time", async () => {
    nextFailure = {
      errorCode: "acpx_turn_failed",
      errorMessage: "Internal error: You've hit your session limit · resets 3:10am (UTC)",
    };
    const { agentId, issueId } = await seedAssignedIssue();
    const runId = await runUntilFailed(agentId, issueId);

    const failed = await heartbeat.getRun(runId);
    expect(failed?.errorCode).toBe("provider_quota");
    expect(failed?.resultJson).toMatchObject({
      errorFamily: "provider_quota",
      providerQuotaKind: "usage_limit",
      providerQuotaResetSource: "provider",
      originalErrorCode: "acpx_turn_failed",
    });
    const retryNotBefore = new Date(String((failed?.resultJson as Record<string, unknown>).retryNotBefore));
    expect(retryNotBefore.getUTCHours()).toBe(3);
    expect(retryNotBefore.getUTCMinutes()).toBe(10);

    const readRetries = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    await expect.poll(async () => (await readRetries()).length, { timeout: 10_000 }).toBe(1);
    const [retry] = await readRetries();
    // Never before the provider reset (the retry is max(transient tier, reset)).
    expect(retry.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(retryNotBefore.getTime());
  }, 30_000);
});

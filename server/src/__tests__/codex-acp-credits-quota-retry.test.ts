import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexAcpExecutor } from "@paperclipai/adapter-codex-local/server";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS, heartbeatService } from "../services/heartbeat.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const adapterType = "credits_quota_integration_test";
const summary = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 8th, 2026 2:00 PM.";

describeEmbedded("Codex ACP credits quota native retry", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;
  let providerTurns = 0;

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
    registerServerAdapter({
      type: adapterType,
      execute: async (ctx) => {
        const result = await execute({
          ...ctx,
          config: { ...ctx.config, engine: "acp", cwd: root, stateDir: path.join(root, "state"),
            env: { CODEX_HOME: path.join(root, "codex-home") } },
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
    });
  }, 30_000);

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(adapterType);
    await tempDb?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("persists the actual ACP classification and waits for one bounded retry without changing the issue", async () => {
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
    expect(providerTurns).toBe(1);
    const [retained] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(retained.status).toBe("in_progress");
    expect(retained.assigneeAgentId).toBe(agentId);
    expect(retained.executionRunId).toBe(retry.id);
    expect((await readRetries())[0].status).toBe("scheduled_retry");
  }, 30_000);
});

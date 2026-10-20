import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexAcpExecutor } from "@paperclipai/adapter-codex-local/server";
import { createClaudeAcpExecutor } from "@paperclipai/adapter-claude-local/server";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  ACP_WRAPPED_QUOTA_RETRY_DELAY_MS,
  createAcpxEngineExecutor,
} from "../../../packages/adapter-utils/src/acpx-engine/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS } from "../services/recovery/service.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const adapterType = "generic_quota_integration_test";
const processAdapterTypes = {
  codex: "codex_process_quota_integration_test",
  claude: "claude_process_quota_integration_test",
};
const fixturePath = fileURLToPath(new URL("../../../scripts/mcp-fixtures/servers/acp-echo-agent.mjs", import.meta.url));

// What each production lane returned before this fix: opencode_local's
// DeepSeek 402 as adapter_failed, the claude_local ACP lane as acpx_turn_failed.
let nextFailure: { errorCode: string; errorMessage: string } = {
  errorCode: "adapter_failed",
  errorMessage: "Insufficient Balance (request_id: dc4ac155-3f57-4b2b-98a3-63346b8c7d95)",
};
let providerTurns = 0;
let terminalAdapter: "shared" | "codex" | "claude" = "shared";
const adapterCallsByAgent = new Map<string, number>();

describeEmbedded("generic adapter provider quota failures", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let acpxStateRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-generic-quota-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    acpxStateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-quota-server-test-"));
    const runtimeOptions = {
      createRuntime: () => ({
        ensureSession: async () => ({
          backendSessionId: "quota-backend-session",
          agentSessionId: "quota-agent-session",
          runtimeSessionName: "quota-runtime-session",
        }),
        startTurn: () => ({
          events: (async function* () {
            yield { type: "done", stopReason: "failed" };
          })(),
          result: Promise.resolve({ status: "failed", error: new Error(nextFailure.errorMessage) }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
    };
    const executors = {
      shared: createAcpxEngineExecutor(runtimeOptions),
      codex: createCodexAcpExecutor(runtimeOptions),
      claude: createClaudeAcpExecutor(runtimeOptions),
    };
    registerServerAdapter({
      type: adapterType,
      execute: async (context) => {
        providerTurns += 1;
        adapterCallsByAgent.set(context.agent.id, (adapterCallsByAgent.get(context.agent.id) ?? 0) + 1);
        if (nextFailure.errorCode === "acpx_turn_failed") {
          const result = await executors[terminalAdapter]({
            ...context,
            config: {
              agent: "custom",
              agentCommand: "node ./synthetic-acp.js",
              stateDir: acpxStateRoot,
              env: {
                CODEX_HOME: path.join(acpxStateRoot, "codex-home"),
                CLAUDE_CONFIG_DIR: path.join(acpxStateRoot, "claude-home"),
                OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "",
              },
            },
          } as never);
          return {
            ...result,
            resultJson: {
              ...(result.resultJson ?? {}),
              conversationContinuation: "continue_conversation_v1",
            },
          };
        }
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
    // Exercise the real ACPX process boundary, independently of the in-memory
    // runtime above. The child is our JSON-RPC fixture, never a provider CLI.
    const processExecutors = {
      codex: createCodexAcpExecutor(),
      claude: createClaudeAcpExecutor(),
    };
    for (const lane of ["codex", "claude"] as const) {
      registerServerAdapter({
        type: processAdapterTypes[lane],
        execute: async (context) => {
          adapterCallsByAgent.set(context.agent.id, (adapterCallsByAgent.get(context.agent.id) ?? 0) + 1);
          const result = await processExecutors[lane](context);
          return {
            ...result,
            resultJson: { ...(result.resultJson ?? {}), conversationContinuation: "continue_conversation_v1" },
          };
        },
        testEnvironment: async () => ({
          adapterType: processAdapterTypes[lane], status: "pass", checks: [], testedAt: new Date().toISOString(),
        }),
      });
    }
  }, 30_000);

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    unregisterServerAdapter(adapterType);
    for (const type of Object.values(processAdapterTypes)) unregisterServerAdapter(type);
    await fs.rm(acpxStateRoot, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedAssignedIssue(type = adapterType, config: Record<string, unknown> = {}) {
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
      adapterType: type, adapterConfig: config, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Synthetic retained obligation", status: "in_progress", priority: "medium",
      responsibleUserId: "responsible-user", assigneeAgentId: agentId,
      issueNumber: 1, identifier: `${prefix}-1`,
    });
    return { companyId, agentId, issueId };
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

  it("persists and schedules the full Kimi ACP wrapped quota terminal failure without another provider turn", async () => {
    nextFailure = {
      errorCode: "acpx_turn_failed",
      errorMessage:
        "Authentication required: 403 You’ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
    };
    const turnsBefore = providerTurns;
    const { agentId, issueId } = await seedAssignedIssue();
    const started = Date.now();
    const runId = await runUntilFailed(agentId, issueId);

    const failed = await heartbeat.getRun(runId);
    expect(failed).toMatchObject({ errorCode: "provider_quota" });
    expect(failed?.resultJson).toMatchObject({
      errorFamily: "provider_quota",
      providerQuotaRetryNotBefore: expect.any(String),
    });

    const readRetries = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    await expect.poll(async () => (await readRetries()).length, { timeout: 10_000 }).toBe(1);
    const [retry] = await readRetries();
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(retry.contextSnapshot).toMatchObject({ issueId, errorFamily: "provider_quota" });
    expect(retry.scheduledRetryAt!.getTime() - started).toBeGreaterThanOrEqual(ACP_WRAPPED_QUOTA_RETRY_DELAY_MS);
    expect(providerTurns - turnsBefore).toBe(1);
  }, 30_000);

  it("keeps a generic quota terminal on the ordinary quota backoff instead of the Kimi five-hour cooldown", async () => {
    nextFailure = {
      errorCode: "acpx_turn_failed",
      errorMessage: "Provider quota exceeded for this model.",
    };
    const { agentId, issueId } = await seedAssignedIssue();
    const started = Date.now();
    const runId = await runUntilFailed(agentId, issueId);
    const failed = await heartbeat.getRun(runId);
    expect(failed).toMatchObject({ errorCode: "provider_quota" });
    expect(failed?.resultJson).toMatchObject({
      errorFamily: "provider_quota",
      providerQuotaResetSource: "default",
      originalErrorCode: "acpx_turn_failed",
    });

    const readRetries = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    await expect.poll(async () => (await readRetries()).length, { timeout: 10_000 }).toBe(1);
    const [retry] = await readRetries();
    expect(retry.contextSnapshot).toMatchObject({ issueId, errorFamily: "provider_quota" });
    expect(retry.scheduledRetryAt!.getTime() - started).toBeGreaterThanOrEqual(
      PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
    );
    expect(retry.scheduledRetryAt!.getTime() - started).toBeLessThan(ACP_WRAPPED_QUOTA_RETRY_DELAY_MS);
  }, 30_000);

  it.each(["codex", "claude"] as const)(
    "classifies the real %s adapter's typed terminal limit and holds new work",
    async (lane) => {
      terminalAdapter = lane;
      nextFailure = {
        errorCode: "acpx_turn_failed",
        errorMessage: "ACP agent reported a terminal limit failure.",
      };
      const { companyId, agentId, issueId } = await seedAssignedIssue();
      const runId = await runUntilFailed(agentId, issueId);
      await heartbeat.drainActiveRunExecutions();
      const failed = await heartbeat.getRun(runId);
      expect(failed?.errorCode).toBe("provider_quota");
      expect(failed?.resultJson).toMatchObject({ errorFamily: "provider_quota", providerQuotaKind: "usage_limit" });
      const due = new Date(String(failed?.resultJson?.providerQuotaRetryNotBefore));
      expect(due.getTime()).toBeGreaterThan(Date.now());

      const nextIssueId = randomUUID();
      await db.insert(issues).values({
        id: nextIssueId, companyId, title: "New work during a provider limit",
        status: "todo", priority: "medium", responsibleUserId: "responsible-user",
        assigneeAgentId: agentId, issueNumber: 2,
        identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
      });
      const queued = await heartbeat.wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: nextIssueId }, requestedByActorType: "user", requestedByActorId: "local-board",
      });
      expect(queued).not.toBeNull();
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect(adapterCallsByAgent.get(agentId)).toBe(1);
      expect((await heartbeat.getRun(queued!.id))?.status).toBe("queued");
      const [retained] = await db.select().from(issues).where(eq(issues.id, nextIssueId));
      expect(retained.status).toBe("todo");
      expect(retained.assigneeAgentId).toBe(agentId);
    }, 30_000,
  );

  it.each(["codex", "claude"] as const)(
    "holds new work after the %s adapter receives a typed limit from a real ACP process",
    async (lane) => {
      const root = path.join(acpxStateRoot, lane);
      const cwd = path.join(root, "workspace");
      const stateDir = path.join(root, "state");
      await fs.mkdir(cwd, { recursive: true });
      const canary = "synthetic-private-provider-limit-detail";
      const { companyId, agentId, issueId } = await seedAssignedIssue(processAdapterTypes[lane], {
        agentCommand: `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`,
        mode: "oneshot", stateDir, cwd, timeoutSec: 15,
        env: {
          HOME: path.join(root, "home"),
          CODEX_HOME: path.join(root, "codex-home"),
          CLAUDE_CONFIG_DIR: path.join(root, "claude-home"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "",
          PAPERCLIP_ACPX_TYPED_FAILURE_CANARY: canary,
          PAPERCLIP_ACPX_TYPED_FAILURE_CATEGORY: "limit",
        },
      });
      const runId = await runUntilFailed(agentId, issueId);
      await heartbeat.drainActiveRunExecutions();
      const failed = await heartbeat.getRun(runId);
      expect(failed?.error).toContain("ACP agent reported a terminal limit failure.");
      expect(failed?.errorCode).toBe("provider_quota");
      expect(failed?.resultJson).toMatchObject({
        originalErrorCode: "acpx_turn_failed", errorFamily: "provider_quota", providerQuotaKind: "usage_limit",
      });
      expect(new Date(String(failed?.resultJson?.providerQuotaRetryNotBefore)).getTime()).toBeGreaterThan(Date.now());
      expect(JSON.stringify({ error: failed?.error, result: failed?.resultJson })).not.toContain(canary);
      const stderr = await fs.readFile(path.join(stateDir, "run-stderr", `${runId}.log`), "utf8");
      expect(stderr).toContain("paperclip-acp-echo-agent started");

      const nextIssueId = randomUUID();
      await db.insert(issues).values({
        id: nextIssueId, companyId, title: "Queued behind a real ACP limit",
        status: "todo", priority: "medium", responsibleUserId: "responsible-user",
        assigneeAgentId: agentId, issueNumber: 2,
        identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
      });
      const queued = await heartbeat.wakeup(agentId, {
        source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: nextIssueId }, requestedByActorType: "user", requestedByActorId: "local-board",
      });
      expect(queued).not.toBeNull();
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      expect(adapterCallsByAgent.get(agentId)).toBe(1);
      expect((await heartbeat.getRun(queued!.id))?.status).toBe("queued");
      const [retained] = await db.select().from(issues).where(eq(issues.id, nextIssueId));
      expect(retained.status).toBe("todo");
      expect(retained.assigneeAgentId).toBe(agentId);
    }, 30_000,
  );
});

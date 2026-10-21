import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS } from "../services/recovery/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const adapterTypes = ["codex_local", "opencode_local"] as const;

describePostgres("persisted provider quota expiry", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let workspace: string;
  let providerCalls = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quota-expiry-");
    db = createDb(tempDb.connectionString);
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-quota-expiry-"));
    for (const type of adapterTypes) registerServerAdapter({
      type,
      execute: async () => {
        providerCalls += 1;
        return {
          exitCode: 1, signal: null, timedOut: false,
          errorCode: "adapter_failed",
          errorMessage: "You've hit your usage limit.",
          resultJson: { conversationContinuation: "continue_conversation_v1" },
        };
      },
      testEnvironment: async () => ({
        adapterType: type, status: "pass", checks: [], testedAt: new Date().toISOString(),
      }),
    });
  }, 30_000);

  afterEach(async () => {
    try {
      await heartbeat?.drainActiveRunExecutions();
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local client_min_messages = warning`);
        await tx.execute(sql`truncate table companies cascade`);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  afterAll(async () => {
    for (const type of adapterTypes) unregisterServerAdapter(type);
    await fs.rm(workspace, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it.each(adapterTypes)("lets %s queued work run after an old quota wait expires across repeated recovery scans", async (adapterType) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const prefix = `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Synthetic quota expiry", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Synthetic quota worker", role: "engineer", status: "idle",
      adapterType, adapterConfig: {
        cwd: workspace,
        env: { CODEX_HOME: workspace, OPENAI_API_KEY: "", CODEX_API_KEY: "" },
      },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Original synthetic work", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user",
      issueNumber: 1, identifier: `${prefix}-1`,
    });
    heartbeat = heartbeatService(db);
    const before = providerCalls;
    // Advance Date only: database, timers, claims and retry promotion remain real.
    // The original failure and both bounded retries must be produced normally;
    // no persisted timestamp or failure receipt is edited to manufacture expiry.
    vi.useFakeTimers({ toFake: ["Date"] });
    // Keep the entire simulated history before the database's real clock;
    // production controller leases deliberately use PostgreSQL clock_timestamp.
    vi.setSystemTime(new Date(Date.now() - 3 * PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS - 120_000));
    const original = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect(original).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    let source = (await heartbeat.getRun(original!.id))!;
    expect(source.status).toBe("failed");

    for (const attempt of [1, 2]) {
      const [retry] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, source.id),
      ));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: attempt });
      vi.setSystemTime(new Date(retry.scheduledRetryAt!.getTime() + 1));
      await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      source = (await heartbeat.getRun(retry.id))!;
      expect(source.status).toBe("failed");
    }
    expect(providerCalls - before).toBe(3);
    expect(source.scheduledRetryAttempt).toBe(2);
    const originalDeadline = String(source.resultJson?.providerQuotaRetryNotBefore);
    const due = new Date(originalDeadline);
    expect(due.getTime()).toBeGreaterThan(Date.now());

    const nextIssueId = randomUUID();
    await db.insert(issues).values({
      id: nextIssueId, companyId, title: "Different ordinary queued work", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user",
      issueNumber: 2, identifier: `${prefix}-2`,
    });
    const queued = await heartbeat.wakeup(agentId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: nextIssueId }, requestedByActorType: "user", requestedByActorId: "local-board",
    });
    expect((await heartbeat.getRun(queued!.id))?.status).toBe("queued");
    expect(providerCalls - before).toBe(3);

    vi.setSystemTime(new Date(due.getTime() + 60_000));
    // A restarted scheduler and repeated stranded scans may install/consume a
    // bounded monitor, but must never re-date this historical provider failure.
    heartbeat = heartbeatService(db);
    for (let scan = 0; scan < 2; scan += 1) {
      await heartbeat.reconcileStrandedAssignedIssues();
      const retained = await heartbeat.getRun(source.id);
      expect(retained?.resultJson?.providerQuotaRetryNotBefore).toBe(originalDeadline);
      expect(retained?.finishedAt).toEqual(source.finishedAt);
    }
    expect(providerCalls - before).toBe(3);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const next = await heartbeat.getRun(queued!.id);
    expect(next?.status).toBe("failed");
    expect(providerCalls - before).toBe(4);
    // A genuinely new provider failure still earns its own new normal wait.
    expect(next?.resultJson).toMatchObject({ errorFamily: "provider_quota", providerQuotaResetSource: "default" });
    expect(new Date(String(next?.resultJson?.providerQuotaRetryNotBefore)).getTime())
      .toBe(next!.finishedAt!.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS);
    const [retainedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(retainedIssue.assigneeAgentId).toBe(agentId);
  }, 30_000);
});

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@paperclipai/adapter-utils/execution-target", async (original) => ({
  ...await original<Record<string, unknown>>(), runAdapterExecutionTargetProcess: vi.fn(),
}));
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentService } from "../services/environments.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("OpenCode SDK provider failure native recovery", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("opencode-native-rate-limit-");
    db = createDb(temp.connectionString); heartbeat = heartbeatService(db);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-native-rate-limit-"));
    await fs.writeFile(path.join(root, "fake-opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    vi.stubEnv("XDG_CONFIG_HOME", root);
  }, 30_000);
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
    await temp?.cleanup();
  });
  it.each([
    [429, undefined, true, true], [429, "600", true, true], [502, undefined, true, true],
    [503, "600", true, true], [504, undefined, true, true], [408, undefined, true, true], [409, undefined, true, true],
    [502, undefined, false, false], [401, undefined, true, false], [403, undefined, true, false],
  ] as const)("SDK status %s with Retry-After %s and retryability %s uses the native retry policy", async (statusCode, retryAfter, isRetryable, expectedRetry) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const prefix = "O" + companyId.replaceAll("-", "").slice(0, 8).toUpperCase();
    await db.insert(companies).values({ id: companyId, name: "Synthetic OpenCode recovery", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "synthetic-owner" });
    await environmentService(db).ensureLocalEnvironment(companyId);
    await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic OpenCode", role: "engineer", status: "idle",
      adapterType: "opencode_local", adapterConfig: { command: path.join(root, "fake-opencode"), cwd: root, model: "nvidia-glm/z-ai/glm-5.3" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic retained task", status: "in_progress",
      responsibleUserId: "synthetic-owner", assigneeAgentId: agentId, issueNumber: 1, identifier: prefix + "-1" });
    const transport = vi.mocked(runAdapterExecutionTargetProcess);
    transport.mockReset();
    transport.mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stderr: "", pid: 123,
      startedAt: new Date().toISOString(), stdout: JSON.stringify({ type: "error", error: { name: "APIError", data: {
        message: "Synthetic provider failure", statusCode,
        isRetryable, responseHeaders: retryAfter ? { "retry-after": retryAfter } : {},
      } } }) } as never);
    const started = Date.now();
    const run = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "synthetic-board" });
    expect(run).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 15_000 }).toBe("failed");
    const failed = await heartbeat.getRun(run!.id);
    const retries = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    if (!expectedRetry) {
      // Await real finalization instead of racing its asynchronous retry decision.
      await heartbeat.drainActiveRunExecutions();
      expect(failed).toMatchObject({ errorCode: "adapter_failed", resultJson: { providerHttpStatus: statusCode } });
      expect(failed?.resultJson).not.toHaveProperty("errorFamily");
      // Existing generic recovery still owns its fallback retry; a terminal SDK
      // result must not be promoted to the provider transient contract or hint.
      expect(failed?.resultJson).not.toHaveProperty("retryNotBefore");
      expect(await retries()).toHaveLength(1);
      expect(transport).toHaveBeenCalledTimes(1);
      return;
    }
    expect(failed).toMatchObject({ errorCode: "opencode_transient_upstream", resultJson: {
      errorFamily: "transient_upstream", providerHttpStatus: statusCode,
    } });
    await expect.poll(async () => (await retries()).length, { timeout: 10_000 }).toBe(1);
    const [retry] = await retries();
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
    expect(retry.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(started + (retryAfter ? 600_000 : 30_000));
    expect(transport).toHaveBeenCalledTimes(1);
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: agentId });
    // Repeated scheduling must share the existing durable retry lineage.
    await heartbeat.scheduleBoundedRetry(run!.id);
    expect(await retries()).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
  }, 40_000);
});

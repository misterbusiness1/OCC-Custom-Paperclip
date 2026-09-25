import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  projectWorkspaces,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  reconcilePersistedRuntimeServicesOnStartup,
  resetRuntimeServicesForTests,
  restartDesiredRuntimeServicesOnStartup,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function reservePort() {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("Failed to reserve a test port");
  return port;
}

function httpService(name: string, port: number, cwd?: string) {
  return {
    name,
    command:
      "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
    ...(cwd ? { cwd } : {}),
    port,
    expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
    readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
    lifecycle: "shared",
    reuseScope: "execution_workspace",
    stopPolicy: { type: "manual" },
  };
}

// Regression: upstream #11740 attached the runtime-service child's `error`
// listener only after an awaited log-handle close. A desired-running service
// whose cwd had disappeared then emitted `spawn /bin/sh ENOENT` with no
// listener, and that uncaught exception killed the whole server during the
// startup desired-state restart.
describeEmbeddedPostgres("startup restart of a desired-running service with a missing cwd", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-missing-cwd-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    await db.delete(activityLog);
    await db.delete(workspaceRuntimeServices);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(activityLog);
    await db.delete(companies);
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("marks the broken service stopped/unhealthy, keeps the process alive, and still restarts healthy siblings", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-missing-cwd-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-missing-cwd-home-"));
    tempDirs.push(workspaceRoot, paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `runtime-missing-cwd-${randomUUID()}`;

    const missingCwd = path.join(workspaceRoot, "OXFA-0000", "deleted-checkout");
    const brokenPort = await reservePort();
    const healthyPort = await reservePort();
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const brokenExecutionWorkspaceId = randomUUID();
    const healthyExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Missing cwd restart",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: workspaceRoot,
      isPrimary: true,
    });
    for (const [id, service] of [
      [brokenExecutionWorkspaceId, httpService("broken-service", brokenPort, missingCwd)],
      [healthyExecutionWorkspaceId, httpService("healthy-service", healthyPort)],
    ] as const) {
      await db.insert(executionWorkspaces).values({
        id,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: `Execution workspace ${id.slice(0, 8)}`,
        status: "active",
        cwd: workspaceRoot,
        providerType: "local_fs",
        providerRef: workspaceRoot,
        metadata: {
          config: {
            workspaceRuntime: { services: [service] },
            desiredState: "running",
            serviceStates: { "0": "running" },
          },
        },
      });
    }

    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await restartDesiredRuntimeServicesOnStartup(db);
      // Let any late next-tick `error` emission or rejection surface.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(uncaught).toEqual([]);
      expect(unhandled).toEqual([]);
      expect(result).toMatchObject({ restarted: 1, failed: 1 });
      expect(result.failures).toEqual([
        expect.objectContaining({
          workspaceKind: "execution_workspace",
          workspaceId: brokenExecutionWorkspaceId,
          error: expect.stringContaining(`service cwd does not exist: ${missingCwd}`),
        }),
      ]);

      const rows = await db.select().from(workspaceRuntimeServices);
      const broken = rows.find((row) => row.executionWorkspaceId === brokenExecutionWorkspaceId);
      const healthy = rows.find((row) => row.executionWorkspaceId === healthyExecutionWorkspaceId);
      expect(broken).toMatchObject({
        serviceName: "broken-service",
        cwd: missingCwd,
        status: "stopped",
        healthStatus: "unhealthy",
      });
      expect(broken?.stoppedAt).not.toBeNull();
      expect(healthy).toMatchObject({ serviceName: "healthy-service", status: "running" });
      await expect(fetch(`http://127.0.0.1:${healthyPort}`)).resolves.toMatchObject({ ok: true });

      // The full startup reconciliation entry point resolves too (no throw).
      await resetRuntimeServicesForTests();
      await expect(reconcilePersistedRuntimeServicesOnStartup(db)).resolves.toMatchObject({
        restartFailed: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(uncaught).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUnhandled);
      for (const executionWorkspaceId of [brokenExecutionWorkspaceId, healthyExecutionWorkspaceId]) {
        await stopRuntimeServicesForExecutionWorkspace({
          db,
          executionWorkspaceId,
          workspaceCwd: workspaceRoot,
        }).catch(() => undefined);
      }
    }
  }, 60_000);
});

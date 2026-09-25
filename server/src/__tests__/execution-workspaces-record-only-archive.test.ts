import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mocks = vi.hoisted(() => ({
  getById: vi.fn(), getCloseReadiness: vi.fn(), update: vi.fn(),
  // Upstream v2026.824.1 archives under the per-workspace lifecycle lock; these
  // stand in for the lock/fence/outcome gateway on the in-memory row.
  archiveWorkspaceUnderLifecycleLock: vi.fn(), fenceClosedWorkspaceDestruction: vi.fn(),
  applyClosedWorkspaceCleanupOutcome: vi.fn(), releaseRuntimeLease: vi.fn(),
  decide: vi.fn(), logActivity: vi.fn(), stop: vi.fn(), destroyLeases: vi.fn(),
  cleanup: vi.fn(), detach: vi.fn(),
}));
vi.mock("../services/index.js", () => ({
  accessService: () => ({ decide: mocks.decide }),
  executionWorkspaceService: () => mocks,
  heartbeatService: () => ({ wakeup: vi.fn() }),
  logActivity: mocks.logActivity,
  workspaceOperationService: () => ({ createRecorder: () => null }),
  workspaceRuntimeLeaseService: () => ({ release: mocks.releaseRuntimeLease, claim: vi.fn(), get: vi.fn() }),
  LEASED_WORKSPACE_RUNTIME_ACTIONS: ["start", "stop", "restart"],
}));
vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({ destroyReusableSandboxLeases: mocks.destroyLeases }),
}));
vi.mock("../services/workspace-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace-runtime.js")>();
  return { ...actual, stopRuntimeServicesForExecutionWorkspace: mocks.stop,
    cleanupExecutionWorkspaceArtifacts: mocks.cleanup };
});

const dirs: string[] = [];
function app() {
  const db = { update: () => ({ set: () => ({ where: mocks.detach }) }) };
  const api = express();
  api.use(express.json());
  api.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "board", companyIds: ["company-1"], source: "session" };
    next();
  });
  api.use("/api", executionWorkspaceRoutes(db as any));
  api.use(errorHandler);
  return api;
}
async function fixture(mode: string, status = "idle", createdByRuntime = false) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "record-only-archive-"));
  dirs.push(cwd);
  await fs.writeFile(path.join(cwd, "preserved.txt"), "synthetic valuable work\n");
  let state = { id: "workspace-1", companyId: "company-1", projectId: null,
    projectWorkspaceId: null, sourceIssueId: null, mode, strategyType: "project_primary",
    status, cwd, providerRef: cwd, providerType: "local_fs", branchName: null,
    repoUrl: null, baseRef: null, metadata: { createdByRuntime }, cleanupReason: null };
  mocks.getById.mockImplementation(async () => state);
  mocks.update.mockImplementation(async (_id, patch) => { state = { ...state, ...patch }; return state; });
  mocks.archiveWorkspaceUnderLifecycleLock.mockImplementation(async ({ patch, closedAt, retryCleanupFailed }) => {
    if (state.status === "archived" || (state.status === "cleanup_failed" && !retryCleanupFailed)) return null;
    state = { ...state, ...patch, status: "archived", closedAt, cleanupReason: null } as typeof state;
    return { outcome: "archived", workspace: state, capturedGeneration: 1 };
  });
  mocks.fenceClosedWorkspaceDestruction.mockImplementation(async ({ destroy }) =>
    ({ skippedReopened: false, result: await destroy() }));
  mocks.applyClosedWorkspaceCleanupOutcome.mockImplementation(async ({ closedAt, cleanupReason, markCleanupFailed }) => {
    state = { ...state, closedAt, cleanupReason, ...(markCleanupFailed ? { status: "cleanup_failed" } : {}) } as typeof state;
    return state;
  });
  mocks.getCloseReadiness.mockResolvedValue({ state: "ready_with_warnings", blockingReasons: [],
    warnings: ["Preserve underlying workspace"], plannedActions: [{ kind: "archive_record" }] });
  return { cwd, state: () => state };
}

describe.sequential("record-only execution workspace archive", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.decide.mockResolvedValue({ allowed: true });
    mocks.stop.mockResolvedValue(undefined);
    mocks.destroyLeases.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.releaseRuntimeLease.mockResolvedValue({ released: false, ownerKey: null });
    const actual = await vi.importActual<typeof import("../services/workspace-runtime.js")>("../services/workspace-runtime.js");
    mocks.cleanup.mockImplementation(actual.cleanupExecutionWorkspaceArtifacts);
  });
  afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

  it.each(["idle", "cleanup_failed"])("archives a shared %s record without treating preserved contents as cleanup failure", async (status) => {
    const f = await fixture("shared_workspace", status);
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    expect(res.body.cleanupReason).toBeNull();
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.destroyLeases).toHaveBeenCalledTimes(1);
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(f.cwd, "preserved.txt"), "utf8")).toBe("synthetic valuable work\n");
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);

    const again = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(again.body.status).toBe("archived");
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("honors a record-only plan even with legacy runtime-created metadata", async () => {
    const f = await fixture("isolated_workspace", "idle", true);
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.cwd, "preserved.txt"), "utf8")).toBe("synthetic valuable work\n");
    expect(mocks.detach).not.toHaveBeenCalled();
  });

  it("still performs explicitly planned disposable artifact cleanup", async () => {
    const f = await fixture("isolated_workspace", "idle", true);
    mocks.getCloseReadiness.mockResolvedValue({ state: "ready", blockingReasons: [],
      plannedActions: [{ kind: "archive_record" }, { kind: "remove_local_directory" }] });
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    await expect(fs.stat(f.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records a reason when an expected artifact remains without warnings", async () => {
    const f = await fixture("isolated_workspace");
    mocks.getCloseReadiness.mockResolvedValue({ state: "ready", blockingReasons: [],
      plannedActions: [{ kind: "archive_record" }, { kind: "remove_local_directory" }] });
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.body.status).toBe("cleanup_failed");
    expect(res.body.cleanupReason).toBe("artifact_cleanup_incomplete: an expected workspace artifact remains");
    expect(await fs.readFile(path.join(f.cwd, "preserved.txt"), "utf8")).toBe("synthetic valuable work\n");
  });

  it("does not conceal an attached runtime stop failure on a record-only archive", async () => {
    const f = await fixture("shared_workspace");
    mocks.stop.mockRejectedValue(new Error("synthetic stop failure"));
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(500);
    expect(f.state().status).toBe("cleanup_failed");
    expect(f.state().cleanupReason).toBe("synthetic stop failure");
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(await fs.stat(f.cwd)).toBeTruthy();
  });

  it("preserves readiness blockers without starting cleanup", async () => {
    const f = await fixture("isolated_workspace");
    mocks.getCloseReadiness.mockResolvedValue({ state: "blocked", blockingReasons: ["Unverified git status"] });
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(409);
    expect(f.state().status).toBe("idle");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.archiveWorkspaceUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.destroyLeases).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("preserves runtime authorization denial", async () => {
    await fixture("shared_workspace");
    mocks.decide.mockResolvedValue({ allowed: false });
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.archiveWorkspaceUnderLifecycleLock).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("does not use a process cwd fallback for a record-only plan without a path", async () => {
    const f = await fixture("isolated_workspace");
    mocks.getById.mockResolvedValue({ ...f.state(), cwd: null, providerRef: null });
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("does not treat an unknown action as permission for artifact cleanup", async () => {
    const f = await fixture("isolated_workspace", "idle", true);
    mocks.getCloseReadiness.mockResolvedValue({ state: "ready", blockingReasons: [],
      plannedActions: [{ kind: "archive_record" }, { kind: "future_unknown_action" }] });
    const res = await request(app()).patch("/api/execution-workspaces/workspace-1").send({ status: "archived" });
    expect(res.status).toBe(200);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(await fs.stat(f.cwd)).toBeTruthy();
  });
});

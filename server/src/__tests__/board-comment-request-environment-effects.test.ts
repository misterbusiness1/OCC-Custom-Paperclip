import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, closeRegisteredClients, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns,
  issueComments, issueCommentRequestEffects, issueCommentRequests, issues, projects, workspaceOperations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { captureBoardCommentSandboxCleanupTargets, createBoardCommentSandboxCleanupHandler, createBoardCommentWorkspaceCleanupHandler } from "../services/board-comment-request-environment-effects.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.js";
import { reserveBoardCommentWorkspaceReopen } from "../services/board-comment-request-workspace-reopen.js";
import { BOARD_COMMENT_WORKSPACE_RESERVATION } from "../services/board-comment-workspace-reservation.js";

const supported = await getEmbeddedPostgresTestSupport();
describe.skipIf(!supported.supported)("durable Board workspace cleanup", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const handler = createBoardCommentWorkspaceCleanupHandler().transaction!;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("board-workspace-cleanup-");
    db = createDb(fixture.connectionString, { maxConnections: 1 });
  }, 60_000);
  afterAll(async () => {
    if (fixture) { await closeRegisteredClients(fixture.connectionString); await fixture.cleanup(); }
  });
  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup fixture", issuePrefix: `W${companyId.slice(0, 7)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Workspace fixture" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Source", status: "done", priority: "medium" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId,
      name: "Owned workspace", mode: "isolated_workspace", strategyType: "git_worktree", status: "active",
      metadata: { lifecycleGeneration: 2, reopenPendingConsumption: true,
        reopenPendingConsumptionSince: new Date().toISOString(), retained: "keep" } });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "board-fixture",
      authorType: "user", body: "Approved follow-up", clientRequestId: randomUUID() }).returning();
    const [request] = await db.insert(issueCommentRequests).values({ companyId, issueId, authorUserId: "board-fixture",
      clientRequestId: comment!.clientRequestId!, commentId: comment!.id, canonicalEnvelope: {},
      acceptedCommentUpdatedAt: comment!.updatedAt, payloadSha256: "b".repeat(64) }).returning();
    const reopenId = randomUUID();
    const [reopen] = await db.insert(issueCommentRequestEffects).values({ id: reopenId, companyId, requestId: request!.id,
      ordinal: 0, kind: "workspace_reopen", descriptor: { version: 1, workspaceId, projectId },
      idempotencyKey: randomUUID(), status: "delivered", receipt: { version: 1, kind: "workspace_reopen",
        requestId: request!.id, effectId: reopenId, workspaceId, reopened: true, generation: 2 } }).returning();
    const [effect] = await db.insert(issueCommentRequestEffects).values({ companyId, requestId: request!.id,
      ordinal: 1, kind: "workspace_cleanup", descriptor: { version: 1, workspaceId, reopenEffectOrdinal: 0 },
      idempotencyKey: randomUUID() }).returning();
    return { companyId, workspaceId, issueId, request: request!, effect: effect!, reopen: reopen!, comment: comment! };
  }
  async function workspace(id: string) {
    return (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;
  }
  async function cancelledReservation() {
    const f = await seed();
    await db.update(executionWorkspaces).set({ status: "archived", metadata: { lifecycleGeneration: 2, retained: "keep" } })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    const [reopen] = await db.update(issueCommentRequestEffects).set({ status: "pending", receipt: null })
      .where(eq(issueCommentRequestEffects.id, f.reopen.id)).returning();
    await db.transaction(tx => reserveBoardCommentWorkspaceReopen(tx, f.request, reopen!));
    await db.update(issueCommentRequestEffects).set({ status: "cancelled" }).where(eq(issueCommentRequestEffects.id, f.reopen.id));
    return f;
  }
  it("releases a cancelled admission reservation without materializing the workspace", async () => {
    const f = await cancelledReservation();
    expect((await workspace(f.workspaceId)).metadata?.[BOARD_COMMENT_WORKSPACE_RESERVATION]).toBeTruthy();
    const receipt = await db.transaction(tx => handler(tx, f.request, f.effect));
    expect(receipt.disposition).toBe("reopen_cancelled_before_dispatch");
    expect(receipt.workspaceActivityIds).toHaveLength(1);
    expect((await db.select().from(activityLog).where(eq(activityLog.id, (receipt.workspaceActivityIds as string[])[0]!)))[0])
      .toMatchObject({ action: "execution_workspace.reopen_cancelled", actorId: f.request.authorUserId });
    expect(await workspace(f.workspaceId)).toMatchObject({ status: "archived", metadata: { retained: "keep", lifecycleGeneration: 3 } });
    expect((await workspace(f.workspaceId)).metadata?.[BOARD_COMMENT_WORKSPACE_RESERVATION]).toBeUndefined();
    expect((await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.reopen.id)))[0]?.status).toBe("cancelled");
  });
  it("keeps an ambiguous executing reservation despite ledger cancellation", async () => {
    const f = await cancelledReservation();
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.reopen.id));
    await db.update(workspaceOperations).set({ metadata: { ...operation!.metadata, phase: "executing" } })
      .where(eq(workspaceOperations.id, f.reopen.id));
    await expect(db.transaction(tx => handler(tx, f.request, f.effect))).rejects.toThrow("cleanup is not proven");
    expect((await workspace(f.workspaceId)).metadata?.[BOARD_COMMENT_WORKSPACE_RESERVATION]).toBeTruthy();
  });
  async function sandbox(holdingRun = false) {
    const f = await seed();
    const environmentId = randomUUID(), leaseId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox",
      config: { provider: "fake", image: "ubuntu:24.04" } });
    let runId: string | null = null;
    if (holdingRun) {
      const agentId = randomUUID(); runId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Holding agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, status: "running" });
    }
    await db.insert(environmentLeases).values({ id: leaseId, environmentId, companyId: f.companyId,
      issueId: f.issueId, executionWorkspaceId: f.workspaceId, heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment", status: "retained", provider: "fake",
      providerLeaseId: `sandbox://fake/${leaseId}`, metadata: { driver: "sandbox" } });
    const targets = await db.transaction(tx => captureBoardCommentSandboxCleanupTargets(tx, {
      companyId: f.companyId, issueId: f.issueId, executionWorkspaceId: f.workspaceId,
    }));
    const [effect] = await db.update(issueCommentRequestEffects).set({ kind: "sandbox_cleanup", descriptor: {
      version: 1, executionWorkspaceId: f.workspaceId, status: "done", leaseTargets: targets,
    } }).where(eq(issueCommentRequestEffects.id, f.effect.id)).returning();
    return { ...f, effect: effect!, leaseId, environmentId, runId };
  }
  const sandboxHandler = createBoardCommentSandboxCleanupHandler().transaction!;
  async function lease(id: string) {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  }
  it("admits only captured resources to cleanup and the existing reaper recovers them", async () => {
    const f = await sandbox();
    const [later] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environmentId,
      issueId: f.issueId, executionWorkspaceId: f.workspaceId, leasePolicy: "reuse_by_environment", status: "retained" }).returning();
    const receipt = await db.transaction(tx => sandboxHandler(tx, f.request, f.effect));
    expect(receipt).toMatchObject({ cleanupAdmitted: true, destroyed: false });
    expect(await lease(f.leaseId)).toMatchObject({ status: "pending_cleanup", metadata: { boardCommentCleanup: {
      requestId: f.request.id, effectId: f.effect.id,
    } } });
    expect((await lease(later!.id)).status).toBe("retained");
    const destroyedIds: string[] = [];
    const runtime = { destroyRunLease: async ({ lease: target }: { lease: { id: string } }) => {
      destroyedIds.push(target.id);
      const [result] = await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success" })
        .where(eq(environmentLeases.id, target.id)).returning();
      return result;
    } } as unknown as HeartbeatEnvironmentRuntime;
    // Recreate the service to prove the cleanup is persisted rather than in-process work.
    const recovered = heartbeatService(db, { environmentRuntime: runtime });
    await recovered.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(destroyedIds).toContain(f.leaseId);
    expect(destroyedIds).not.toContain(later!.id);
    expect((await lease(f.leaseId)).status).toBe("expired");
    await recovered.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(destroyedIds.filter(id => id === f.leaseId)).toHaveLength(1);
  });
  it("rolls back cleanup admission with the request receipt", async () => {
    const f = await sandbox();
    await expect(db.transaction(async tx => { await sandboxHandler(tx, f.request, f.effect); throw new Error("rollback"); }))
      .rejects.toThrow("rollback");
    expect((await lease(f.leaseId)).status).toBe("retained");
    expect((await lease(f.leaseId)).metadata).not.toHaveProperty("boardCommentCleanup");
  });
  it("does not reclaim a lease whose captured ownership changed", async () => {
    const f = await sandbox();
    await db.update(environmentLeases).set({ providerLeaseId: "a-different-resource" }).where(eq(environmentLeases.id, f.leaseId));
    const result = await db.transaction(tx => sandboxHandler(tx, f.request, f.effect));
    expect(result.outcomes).toEqual([{ leaseId: f.leaseId, disposition: "resource_identity_changed" }]);
    expect((await lease(f.leaseId)).status).toBe("retained");
  });
  it("preserves a live holding run and records its finalizer ownership", async () => {
    const f = await sandbox(true);
    const result = await db.transaction(tx => sandboxHandler(tx, f.request, f.effect));
    expect(result.outcomes).toEqual([{ leaseId: f.leaseId, disposition: "holding_run_finalizer_owns_cleanup", holdingRunId: f.runId }]);
    expect((await lease(f.leaseId)).status).toBe("retained");
  });
  it("does not admit cleanup after an issue has resumed", async () => {
    const f = await sandbox();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    expect(await db.transaction(tx => sandboxHandler(tx, f.request, f.effect))).toMatchObject({
      cleanupAdmitted: false, disposition: "issue_no_longer_terminal",
    });
    expect((await lease(f.leaseId)).status).toBe("retained");
  });
  it("clears only the owned pending fence, preserving the workspace and unrelated metadata", async () => {
    const f = await seed();
    const receipt = await db.transaction(tx => handler(tx, f.request, f.effect));
    expect(receipt.disposition).toBe("unconsumed_fence_cleared");
    expect(receipt.workspaceActivityIds).toHaveLength(1);
    expect(await workspace(f.workspaceId)).toMatchObject({ status: "active", metadata: { lifecycleGeneration: 2, retained: "keep" } });
    expect((await workspace(f.workspaceId)).metadata).not.toHaveProperty("reopenPendingConsumption");
    expect((await workspace(f.workspaceId)).metadata).not.toHaveProperty("reopenPendingConsumptionSince");
    const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "execution_workspace.reopen_unconsumed", actorId: "board-fixture" });
  });
  it("rolls back the fence and audit when the completion transaction fails", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await handler(tx, f.request, f.effect); throw new Error("receipt write failed"); }))
      .rejects.toThrow("receipt write failed");
    expect((await workspace(f.workspaceId)).metadata?.reopenPendingConsumption).toBe(true);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual([]);
    await db.transaction(tx => handler(tx, f.request, f.effect));
    expect((await workspace(f.workspaceId)).metadata?.reopenPendingConsumption).toBeUndefined();
  });
  it("never clears a newer reopen generation", async () => {
    const f = await seed(), before = await workspace(f.workspaceId);
    await db.update(executionWorkspaces).set({ metadata: { ...before.metadata, lifecycleGeneration: 3 } }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect((await db.transaction(tx => handler(tx, f.request, f.effect))).disposition).toBe("newer_workspace_lifecycle");
    expect((await workspace(f.workspaceId)).metadata?.reopenPendingConsumption).toBe(true);
  });
  it("keeps the workspace write locked until the receipt transaction commits", async () => {
    const f = await seed();
    const independent = createDb(fixture.connectionString, { maxConnections: 1 });
    let entered!: () => void, release!: () => void;
    const mutated = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction(async tx => {
      await handler(tx, f.request, f.effect);
      entered();
      await held;
    });
    try {
      await mutated;
      await expect(independent.transaction(tx => tx.execute(sql`select id from execution_workspaces
        where id = ${f.workspaceId} for update nowait`))).rejects.toThrow();
    } finally {
      release();
      await transaction;
    }
    expect((await workspace(f.workspaceId)).metadata?.reopenPendingConsumption).toBeUndefined();
  });
  it("retains cleanup obligation for an ambiguous reopen", async () => {
    const f = await seed();
    await db.update(issueCommentRequestEffects).set({ status: "reconciliation_required", receipt: null }).where(eq(issueCommentRequestEffects.id, f.reopen.id));
    await expect(db.transaction(tx => handler(tx, f.request, f.effect))).rejects.toThrow("outcome is not proven");
    expect((await workspace(f.workspaceId)).metadata?.reopenPendingConsumption).toBe(true);
  });
  it("allows owned cleanup after the source comment is removed", async () => {
    const f = await seed();
    await db.update(issueComments).set({ deletedAt: new Date(), body: "" }).where(eq(issueComments.id, f.comment.id));
    expect((await db.transaction(tx => handler(tx, f.request, f.effect))).disposition).toBe("unconsumed_fence_cleared");
  });
  it("rejects a stale effect generation", async () => {
    const f = await seed();
    await db.update(issueCommentRequestEffects).set({ generation: f.effect.generation + 1 }).where(eq(issueCommentRequestEffects.id, f.effect.id));
    await expect(db.transaction(tx => handler(tx, f.request, f.effect))).rejects.toThrow("claim is no longer current");
    expect((await workspace(f.workspaceId)).metadata?.reopenPendingConsumption).toBe(true);
  });
  it("requires a receipt correlated to this exact request", async () => {
    const f = await seed();
    await db.update(issueCommentRequestEffects).set({ receipt: { ...f.reopen.receipt, requestId: randomUUID() } }).where(eq(issueCommentRequestEffects.id, f.reopen.id));
    await expect(db.transaction(tx => handler(tx, f.request, f.effect))).rejects.toThrow("outcome is not proven");
  });
  it("does not claim ownership when another request reopened the workspace", async () => {
    const f = await seed();
    await db.update(issueCommentRequestEffects).set({ receipt: { ...f.reopen.receipt, reopened: false } }).where(eq(issueCommentRequestEffects.id, f.reopen.id));
    expect((await db.transaction(tx => handler(tx, f.request, f.effect))).disposition).toBe("reopen_owned_by_another_request");
    expect((await workspace(f.workspaceId)).metadata?.reopenPendingConsumption).toBe(true);
  });
});

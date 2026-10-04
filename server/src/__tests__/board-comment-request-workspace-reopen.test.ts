import { workspaceOperationService } from "../services/workspace-operations.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { companies, projects, projectWorkspaces, issues, agents, heartbeatRuns, executionWorkspaces, issueComments, issueCommentRequests,
  issueCommentRequestEffects, workspaceOperations, createDb, closeRegisteredClients } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { acceptedCommentDigest, type CommentRequestEnvelope } from "../services/issue-comment-request-canonical.js";
import { reserveBoardCommentWorkspaceReopen, createBoardCommentWorkspaceReopenHandler,
  cancelReservedBoardCommentWorkspaceReopen, recoverOrphanedBoardCommentWorkspaceReservations } from "../services/board-comment-request-workspace-reopen.js";
import { assertBoardCommentWorkspaceMaterializationAllowed } from "../services/board-comment-workspace-reservation.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("durable Board workspace reopen reservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, cwd: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("board-workspace-reservation-");
    db = createDb(database.connectionString, { maxConnections: 2 });
    cwd = await mkdtemp(join(tmpdir(), "board-workspace-artifact-"));
  }, 60_000);
  afterAll(async () => {
    if (database) { await closeRegisteredClients(database.connectionString); await database.cleanup(); }
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });
  async function seed(status = "archived") {
    const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reservation fixture", issuePrefix: `W${companyId.slice(0, 7)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Reserved project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Reopened issue", status: "todo" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId,
      name: "Reserved workspace", mode: "isolated_workspace", strategyType: "project_primary", cwd, status,
      metadata: { lifecycleGeneration: 4, retained: "keep" } });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "board-fixture",
      authorType: "user", body: "Please resume", clientRequestId: randomUUID() }).returning();
    const envelope = { authorization: { source: "local_implicit" }, attachments: [] } as unknown as CommentRequestEnvelope;
    const [request] = await db.insert(issueCommentRequests).values({ companyId, issueId, authorUserId: "board-fixture",
      clientRequestId: comment!.clientRequestId!, commentId: comment!.id, canonicalEnvelope: envelope as unknown as Record<string, unknown>,
      acceptedCommentUpdatedAt: comment!.updatedAt, payloadSha256: acceptedCommentDigest(envelope, comment!) }).returning();
    const [effect] = await db.insert(issueCommentRequestEffects).values({ companyId, requestId: request!.id,
      ordinal: 0, kind: "workspace_reopen", descriptor: { version: 1, workspaceId, projectId }, idempotencyKey: randomUUID() }).returning();
    return { companyId, projectId, issueId, workspaceId, comment: comment!, request: request!, effect: effect! };
  }
  async function workspace(id: string) { return (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!; }
  async function reserve(f: Awaited<ReturnType<typeof seed>>) { return db.transaction(tx => reserveBoardCommentWorkspaceReopen(tx, f.request, f.effect)); }
  async function dispatch(f: Awaited<ReturnType<typeof seed>>) {
    const [effect] = await db.update(issueCommentRequestEffects).set({ status: "dispatching", generation: 1 })
      .where(eq(issueCommentRequestEffects.id, f.effect.id)).returning();
    return createBoardCommentWorkspaceReopenHandler(db).execute!(f.request, effect!);
  }
  it("rejects a live linked execution and a workspace from another project", async () => {
    const f = await seed();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Active owner" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "running" }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, f.issueId));
    await expect(reserve(f)).rejects.toThrow("active execution owner");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    const foreign = { ...f.effect, descriptor: { ...f.effect.descriptor, projectId: randomUUID() } };
    await expect(db.transaction(tx => reserveBoardCommentWorkspaceReopen(tx, f.request, foreign))).rejects.toThrow("outside accepted project");
  });
  it("will not release a changed resource or claim another reserved generation", async () => {
    const f = await seed(); await reserve(f);
    await expect(reserve(f)).rejects.toThrow("already has");
    await db.update(executionWorkspaces).set({ cwd: "/different-resource" }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await db.transaction(tx => cancelReservedBoardCommentWorkspaceReopen(tx,
      { companyId: f.companyId, operationId: f.effect.id, requestId: f.request.id }))).toMatchObject({ released: false, reason: "resource_identity_changed" });
  });
  it("waits for an uncommitted reservation before a different issue runtime can materialize", async () => {
    const f = await seed();
    const contender = createDb(database.connectionString, { maxConnections: 1, applicationName: "reopen-share-contender" });
    let ready!: () => void, release!: () => void;
    const readySignal = new Promise<void>(resolve => { ready = resolve; });
    const releaseSignal = new Promise<void>(resolve => { release = resolve; });
    const admitted = db.transaction(async tx => { await reserveBoardCommentWorkspaceReopen(tx, f.request, f.effect); ready(); await releaseSignal; });
    await readySignal;
    const guarded = assertBoardCommentWorkspaceMaterializationAllowed(contender, f.workspaceId, {});
    const observed = guarded.then(() => ({ allowed: true }), error => ({ error }));
    try {
      const deadline = Date.now() + 5000;
      for (;;) {
        const rows = await db.execute(sql`SELECT cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity WHERE application_name = 'reopen-share-contender'`);
        if ((rows as unknown as { blockers: number }[]).some(row => Number(row.blockers) > 0)) break;
        if (Date.now() >= deadline) throw new Error("Materialization guard did not wait for reservation lock");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { release(); }
    await admitted;
    expect(await observed).toHaveProperty("error");
  });
  it("rejects admission when a previously guarded different-issue run owns the workspace", async () => {
    const f = await seed();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, projectId: f.projectId,
      title: "Other task", status: "todo", executionWorkspaceId: f.workspaceId });
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Earlier owner" }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "running",
      contextSnapshot: { issueId: otherIssueId } });
    await assertBoardCommentWorkspaceMaterializationAllowed(db, f.workspaceId, {});
    await expect(reserve(f)).rejects.toThrow("active execution owner");
  });
  it("recognizes the durable repair operation before its physical callback starts", async () => {
    const f = await seed();
    let ready!: () => void, release!: () => void;
    const readySignal = new Promise<void>(resolve => { ready = resolve; });
    const releaseSignal = new Promise<void>(resolve => { release = resolve; });
    const operation = workspaceOperationService(db).createRecorder({ companyId: f.companyId, executionWorkspaceId: f.workspaceId })
      .recordOperation({ phase: "workspace_repair", metadata: { action: "repair" }, run: async () => {
        await assertBoardCommentWorkspaceMaterializationAllowed(db, f.workspaceId, {});
        ready(); await releaseSignal; return { status: "succeeded" };
      } });
    const observed = operation.then(value => ({ value }), error => ({ error }));
    await readySignal;
    try { await expect(reserve(f)).rejects.toThrow("active physical operation"); }
    finally { release(); }
    expect(await observed).toHaveProperty("value");
  });
  it("rolls back reservation, generation, and operation atomically", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await reserveBoardCommentWorkspaceReopen(tx, f.request, f.effect); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect((await workspace(f.workspaceId)).metadata).toEqual({ lifecycleGeneration: 4, retained: "keep" });
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.effect.id))).toHaveLength(0);
  });
  it("blocks heartbeat materialization and legacy archive/reopen while reserved", async () => {
    const f = await seed(); await reserve(f);
    await expect(assertBoardCommentWorkspaceMaterializationAllowed(db, f.workspaceId, {})).rejects.toThrow("reserved");
    await expect(executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({ workspaceId: f.workspaceId,
      issue: { id: f.issueId, companyId: f.companyId, projectId: f.projectId }, actor: { agentId: null, actorType: "user" } })).rejects.toThrow("reserved");
    expect(await executionWorkspaceService(db).archiveWorkspaceUnderLifecycleLock({ id: f.workspaceId, patch: {}, closedAt: new Date() })).toMatchObject({ outcome: "reopen_pending" });
  });
  it("materializes once through canonical helper and recovers completed receipt after restart", async () => {
    const f = await seed(); await reserve(f);
    expect(await dispatch(f)).toMatchObject({ reopened: true, generation: 5 });
    expect(await workspace(f.workspaceId)).toMatchObject({ status: "active", metadata: { lifecycleGeneration: 5, retained: "keep", reopenPendingConsumption: true } });
    expect((await workspace(f.workspaceId)).metadata).not.toHaveProperty("boardCommentReopenReservation");
    expect(await createBoardCommentWorkspaceReopenHandler(db).reconcile!(f.request, f.effect)).toMatchObject({ reopened: true, generation: 5 });
  });
  it("reconstructs a removed Git worktree while reservation stays owned and database locks are released", async () => {
    const f = await seed();
    const repo = join(cwd, `repo-${f.workspaceId}`), worktree = join(cwd, `tree-${f.workspaceId}`);
    const started = join(cwd, `started-${f.workspaceId}`), release = join(cwd, `release-${f.workspaceId}`);
    const script = join(cwd, `barrier-${f.workspaceId}.cjs`);
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "proof.txt"), "preserved committed content\n");
    git("add", "proof.txt"); git("commit", "-m", "fixture");
    const head = git("rev-parse", "HEAD");
    git("worktree", "add", "-b", "accepted-followup", worktree, "main");
    git("worktree", "remove", worktree);
    await expect(access(worktree)).rejects.toThrow();
    await writeFile(script, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(started)},'ready'); const until=Date.now()+20000; while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>until)throw Error('test barrier timed out'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}`);
    const [base] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
      name: "Local base", sourceType: "local_path", cwd: repo, isPrimary: true }).returning();
    await db.update(executionWorkspaces).set({ strategyType: "git_worktree", cwd: worktree, providerRef: worktree,
      projectWorkspaceId: base!.id, baseRef: "main", branchName: "accepted-followup", metadata: {
        lifecycleGeneration: 4, retained: "keep", config: { provisionCommand: `node ${JSON.stringify(script)}` },
      } }).where(eq(executionWorkspaces.id, f.workspaceId));
    await reserve(f);
    const operation = dispatch(f);
    // Attach rejection immediately so a failed helper never becomes an unhandled promise.
    const settled = operation.then(value => ({ value }), error => ({ error }));
    try {
      const deadline = Date.now() + 15000;
      for (;;) {
        try { await access(started); break; } catch { if (Date.now() >= deadline) throw new Error("Git provisioning barrier not reached"); }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(await readFile(join(worktree, "proof.txt"), "utf8")).toBe("preserved committed content\n");
      expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree }).toString().trim()).toBe(head);
      expect((await workspace(f.workspaceId)).metadata).toMatchObject({ lifecycleGeneration: 5,
        boardCommentReopenReservation: { operationId: f.effect.id, generation: 5 } });
      expect((await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.effect.id)))[0]?.metadata?.phase).toBe("executing");
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
        await tx.execute(sql`SELECT id FROM issues WHERE id = ${f.issueId} FOR UPDATE NOWAIT`);
        await tx.execute(sql`SELECT id FROM issue_comment_requests WHERE id = ${f.request.id} FOR UPDATE NOWAIT`);
        await tx.execute(sql`SELECT id FROM issue_comment_request_effects WHERE id = ${f.effect.id} FOR UPDATE NOWAIT`);
        await tx.execute(sql`SELECT id FROM execution_workspaces WHERE id = ${f.workspaceId} FOR UPDATE NOWAIT`);
        const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${f.workspaceId}`}, 0)) AS acquired`);
        expect((result as unknown as { acquired: boolean }[])[0]?.acquired).toBe(true);
      });
      await expect(assertBoardCommentWorkspaceMaterializationAllowed(db, f.workspaceId, {})).rejects.toThrow("reserved");
    } finally { await writeFile(release, "continue"); }
    const result = await settled;
    if ("error" in result) throw result.error;
    expect(result.value).toMatchObject({ reopened: true, generation: 5 });
    expect((await workspace(f.workspaceId)).metadata).toMatchObject({ lifecycleGeneration: 5, retained: "keep", reopenPendingConsumption: true });
    expect((await workspace(f.workspaceId)).metadata).not.toHaveProperty("boardCommentReopenReservation");
  }, 30000);
  it("does not own an already-open workspace pending flag", async () => {
    const f = await seed("active"); await reserve(f);
    expect(await dispatch(f)).toMatchObject({ reopened: false, generation: 4 });
    expect((await workspace(f.workspaceId)).metadata).not.toHaveProperty("reopenPendingConsumption");
  });
  it("releases a cancelled never-dispatched reservation without physical work", async () => {
    const f = await seed(); await reserve(f);
    expect(await db.transaction(tx => cancelReservedBoardCommentWorkspaceReopen(tx,
      { companyId: f.companyId, operationId: f.effect.id, requestId: f.request.id }))).toMatchObject({ released: true });
    expect((await workspace(f.workspaceId)).status).toBe("archived");
    expect((await workspace(f.workspaceId)).metadata).not.toHaveProperty("boardCommentReopenReservation");
  });
  it("preserves executing ambiguity and never replays materialization", async () => {
    const f = await seed(); await reserve(f);
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.effect.id));
    await db.update(workspaceOperations).set({ metadata: { ...operation!.metadata, phase: "executing", executingGeneration: 1 } }).where(eq(workspaceOperations.id, f.effect.id));
    await expect(dispatch(f)).rejects.toThrow("requires reconciliation");
    expect(await createBoardCommentWorkspaceReopenHandler(db).reconcile!(f.request, f.effect)).toBeNull();
    expect(await db.transaction(tx => cancelReservedBoardCommentWorkspaceReopen(tx,
      { companyId: f.companyId, operationId: f.effect.id, requestId: f.request.id }))).toMatchObject({ released: false });
  });
  it("settles a never-executed operation whose workspace was legitimately deleted", async () => {
    const f = await seed(); await reserve(f);
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await db.transaction(tx => cancelReservedBoardCommentWorkspaceReopen(tx,
      { companyId: f.companyId, operationId: f.effect.id, requestId: f.request.id }))).toMatchObject({ reason: "workspace_removed" });
    expect((await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.effect.id)))[0]).toMatchObject({ status: "cancelled", metadata: { phase: "cancelled" } });
  });
  it("survives legitimate issue deletion and releases only the orphan reserved operation", async () => {
    const f = await seed(); await reserve(f);
    await db.delete(issues).where(eq(issues.id, f.issueId));
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.effect.id))).toHaveLength(1);
    expect(await recoverOrphanedBoardCommentWorkspaceReservations(db)).toMatchObject({ released: 1 });
    expect((await workspace(f.workspaceId)).metadata).not.toHaveProperty("boardCommentReopenReservation");
  });
});

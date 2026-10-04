import { admitBoardCommentCancellation } from "../services/board-comment-cancellation.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { recordNativeLocalProcessStop } from "../services/native-local-process-stop.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { heartbeatRuns, nativeRunFinalizations, agents, agentWakeupRequests, companies, createDb, issueComments, issueCommentRequestEffects, issues,
  closeRegisteredClients, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { issueCommentRequestService } from "../services/issue-comment-requests.js";
import { authorizeBoardCommentRequest } from "../services/board-comment-request-authority.js";
import { boardCommentRequestRuntimeEffects } from "../services/board-comment-request-runtime-effects.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
suite("Board comment concrete runtime wake delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-runtime-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 30_000);
  afterAll(async () => { await closeRegisteredClients(database.connectionString); await database.cleanup(); });
  it.each([
    ["interrupt", "issue_comment_interrupt"],
    ["scheduled_retry_cancel", "issue_comment_scheduled_retry_superseded"],
    ["cancel_native_question_run", "issue_status_transition_native_question"],
  ] as const)("preserves truthful %s cancellation attribution", async (kind, source) => {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Attribution proof", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Attributed agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Attributed request", status: "todo", assigneeAgentId: agentId });
    const native = kind === "cancel_native_question_run";
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", executionStage: "preparing",
      runtimeMode: native ? "native" : "legacy", nativeIssueId: native ? issueId : null }).returning();
    if (native) await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: run.id, phase: "observed", attempt: 0 });
    type Options = NonNullable<Parameters<ReturnType<typeof heartbeatService>["cancelRun"]>[2]>;
    let captured: Options | undefined;
    const control = { wakeup: async () => null, waitForRunExecutionDrain: async () => {},
      cancelRun: async (id: string, _reason?: string, options?: Options) => {
        captured = options;
        const marker = await admitBoardCommentCancellation(db, id, options!.boardCommentClaim!);
        const [cancelled] = await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
          resultJson: { ...options!.resultJson, boardCommentCancellation: marker,
            ...(native ? { startupPreparationSettledAt: new Date().toISOString() } : {}) } }).where(eq(heartbeatRuns.id, id)).returning();
        return cancelled;
      } };
    const service = issueCommentRequestService(db, { controls: () => ({ admission: true, dispatch: true }),
      authorize: authorizeBoardCommentRequest, handlers: boardCommentRequestRuntimeEffects(db, control) });
    const input = { companyId, issueId, authorUserId: "local-board", actorSource: "local_implicit", clientRequestId: randomUUID(), body: "Approved action" };
    const accepted = await service.admit(input, async tx => {
      const [comment] = await tx.insert(issueComments).values({ companyId, issueId, authorType: "user",
        authorUserId: input.authorUserId, clientRequestId: input.clientRequestId, body: input.body }).returning();
      return { commentId: comment.id, effects: [{ kind, descriptor: { version: 1, targetRunId: run.id,
        ...(native ? { issueStatus: "done" } : {}) } }] };
    });
    await service.dispatchOne(companyId, accepted.request.id);
    expect(captured).toBeDefined();
    expect(captured!.eventPayload).toMatchObject({ source, requestedByActorType: "user", requestedByActorId: "local-board",
      requestId: accepted.request.id, commentId: accepted.request.commentId });
    if (kind === "interrupt") {
      expect(captured!.resultJson).toMatchObject({ operatorInterrupted: true, interruptionSource: source,
        interruptedByActorType: "user", interruptedByActorId: "local-board" });
    } else {
      for (const key of ["operatorInterrupted", "interruptionSource", "interruptedIssueId", "interruptedByActorType", "interruptedByActorId"]) {
        expect(captured!.resultJson).not.toHaveProperty(key); expect(captured!.eventPayload).not.toHaveProperty(key);
      }
      expect(captured!.resultJson).toMatchObject(native
        ? { cancelledByIssueStatus: "done", cancelledIssueId: issueId }
        : { scheduledRetrySupersededByComment: true, supersededIssueId: issueId });
    }
    const [effect] = await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
    expect(effect.status, JSON.stringify(effect)).toBe("delivered");
  });
  it("keeps native cancellation ambiguous until physical stop evidence arrives, then admits one successor", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native proof", issuePrefix: `N${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Proof fixture", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Captured work", status: "todo", assigneeAgentId: agentId });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "cancelled", finishedAt: new Date(),
      resultJson: { nativeCancellation: { dispatchState: "acknowledged", dispatched: true } } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: run.id, phase: "terminal_failure", attempt: 1 });
    const heartbeat = heartbeatService(db); heartbeat.startTaskDrain(); let clock = Date.now();
    const service = issueCommentRequestService(db, { now: () => new Date(clock), controls: () => ({ admission: true, dispatch: true }),
      authorize: authorizeBoardCommentRequest, handlers: boardCommentRequestRuntimeEffects(db, heartbeat) });
    try {
      const input = { companyId, issueId, authorUserId: "local-board", actorSource: "local_implicit", clientRequestId: randomUUID(), body: "Continue after stop" };
      const accepted = await service.admit(input, async tx => {
        const [comment] = await tx.insert(issueComments).values({ companyId, issueId, authorType: "user",
          authorUserId: input.authorUserId, clientRequestId: input.clientRequestId, body: input.body }).returning();
        return { commentId: comment.id, effects: [
          { kind: "interrupt", descriptor: { version: 1, targetRunId: run.id } },
          { kind: "wake", descriptor: { version: 1, agentId, wakeup: { source: "automation", triggerDetail: "system", reason: "issue_commented",
            payload: { issueId, commentId: comment.id }, contextSnapshot: { issueId, commentId: comment.id } } } },
        ] };
      });
      await service.dispatchOne(companyId, accepted.request.id);
      const effects = await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
      expect(effects.find(effect => effect.kind === "interrupt")?.status).toBe("reconciliation_required");
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
      const pid = child.pid!; await once(child, "exit");
      expect(await recordNativeLocalProcessStop(db, { ...run, processPid: pid, processGroupId: pid })).toBe(true);
      clock += 31_000;
      await service.dispatchOne(companyId, accepted.request.id);
      await service.dispatchOne(companyId, accepted.request.id);
      const settled = await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
      expect(settled.every(effect => effect.status === "delivered"), JSON.stringify(settled)).toBe(true);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(1);
    } finally { heartbeat.stopTaskDrain(); }
  });
  it("retains each permanent receipt when follow-up comments merge into a deferred wake", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), ownerAgentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deferred proof", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Deferred fixture", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } });
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Existing owner", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Running work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: ownerAgentId, status: "running", executionStage: "running",
      startedAt: new Date(), processPid: process.pid, controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
      contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    let providerAttempts = 0;
    const heartbeat = heartbeatService(db, { beforeLegacyAdapterDispatch: async () => { providerAttempts++; throw new Error("Unexpected provider dispatch in queue test"); } });
    const service = issueCommentRequestService(db, { controls: () => ({ admission: true, dispatch: true }),
      authorize: authorizeBoardCommentRequest, handlers: boardCommentRequestRuntimeEffects(db, heartbeat) });
    try {
      for (let i = 0; i < 2; i++) {
        const input = { companyId, issueId, authorUserId: "local-board", actorSource: "local_implicit", clientRequestId: randomUUID(), body: `Follow-up ${i}` };
        const accepted = await service.admit(input, async tx => {
          const [comment] = await tx.insert(issueComments).values({ companyId, issueId, authorType: "user",
            authorUserId: input.authorUserId, clientRequestId: input.clientRequestId, body: input.body }).returning();
          return { commentId: comment.id, effects: [{ kind: "wake", descriptor: { version: 1, agentId,
            wakeup: { source: "automation", triggerDetail: "system", reason: "issue_commented",
              payload: { issueId, commentId: comment.id }, contextSnapshot: { issueId, commentId: comment.id, wakeCommentId: comment.id } } } }] };
        });
        await service.dispatchOne(companyId, accepted.request.id);
        const [effect] = await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
        expect(effect.status, JSON.stringify(effect)).toBe("delivered");
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, effect.idempotencyKey))).toHaveLength(1);
      }
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakes.map(wake => wake.status).sort(), JSON.stringify(wakes)).toEqual(["coalesced", "deferred_issue_execution"]);
      expect(providerAttempts).toBe(0);
    } finally { await heartbeat.drainActiveRunExecutions(); }
  });
  it("persists a normal heartbeat admission and reuses it across a recreated dispatcher", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wake proof", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Runtime fixture", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Accepted work", status: "todo", assigneeAgentId: agentId });
    const heartbeat = heartbeatService(db); heartbeat.startTaskDrain();
    const handlers = boardCommentRequestRuntimeEffects(db, heartbeat);
    const service = () => issueCommentRequestService(db, { controls: () => ({ admission: true, dispatch: true }),
      authorize: authorizeBoardCommentRequest, handlers });
    try {
      const input = { companyId, issueId, authorUserId: "local-board", actorSource: "local_implicit",
        clientRequestId: randomUUID(), body: "Approved runtime work" };
      const accepted = await service().admit(input, async tx => {
        const [comment] = await tx.insert(issueComments).values({ companyId, issueId, authorType: "user",
          authorUserId: input.authorUserId, clientRequestId: input.clientRequestId, body: input.body }).returning();
        return { commentId: comment.id, effects: [{ kind: "wake", descriptor: { version: 1, agentId,
          wakeup: { source: "automation", triggerDetail: "system", reason: "issue_commented",
            payload: { issueId, commentId: comment.id }, contextSnapshot: { issueId, commentId: comment.id } } } }] };
      });
      await service().dispatchOne(companyId, accepted.request.id);
      const [effect] = await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.request.id));
      expect(effect.status, JSON.stringify(effect)).toBe("delivered");
      expect(effect.receipt).toMatchObject({ durableAdmission: true });
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, effect.idempotencyKey));
      expect(wake).toBeTruthy(); expect(wake.requestedByActorId).toBe("local-board");
      const recovered = await boardCommentRequestRuntimeEffects(db, heartbeatService(db)).wake!.reconcile!(accepted.request, effect);
      expect(recovered).toMatchObject({ wakeRequestId: wake.id, durableAdmission: true });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, effect.idempotencyKey))).toHaveLength(1);
    } finally { heartbeat.stopTaskDrain(); }
  });
});

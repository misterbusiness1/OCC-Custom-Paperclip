import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.js";
import { runningProcesses } from "../adapters/index.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Responsible-user invariant test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function deleteHeartbeatRunsAfterEvents(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt < 4 &&
        message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
  }
}

describeEmbeddedPostgres("heartbeat responsible-user invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-responsible-user-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    const baseExecute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementation(async (...args: unknown[]) => {
      const context = (args[0] as { context?: Record<string, unknown> } | undefined)?.context;
      if (context?.wakeReason === "issue_disposition_repair" && typeof context.issueId === "string") {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, context.issueId));
      }
      return baseExecute();
    });
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: false });
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes. The shared drain also awaits an in-flight
    // wakeup that is still before run registration, which a plain run table
    // status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await deleteHeartbeatRunsAfterEvents(db);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedCompany() {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    return { companyId, ownerUserId, agentId };
  }

  it.each(["ordinary task", "persistent conversation"] as const)(
    "dispatches an interrupted queue once under the clicking operator for an %s",
    async (scope) => {
      const { companyId, agentId, ownerUserId } = await seedCompany();
      const operatorId = `operator-${randomUUID()}`, issueId = randomUUID(), commentId = randomUUID(), queueId = randomUUID();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: operatorId,
        membershipRole: "operator", status: "active" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Interrupted queue", status: "todo",
        assigneeAgentId: agentId, responsibleUserId: ownerUserId,
        ...(scope === "persistent conversation" ? {
          conversationAgentId: agentId,
          conversationUserId: operatorId,
          conversationState: "active" as const,
        } : {}),
      });
      await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: ownerUserId, body: "Continue the task" });
      await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId,
        source: "automation", status: "deferred_issue_execution", requestedByActorType: "system",
        payload: { issueId, commentId, queuedCommentInterrupt: { actorId: operatorId, requestedAt: new Date().toISOString() },
          _paperclipWakeContext: { wakeCommentIds: [commentId], responsibleUserId: ownerUserId,
            retryOfRunId: randomUUID(), originIdentityContextId: randomUUID() } },
      });
      if (scope === "persistent conversation") {
        await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
      }
      await heartbeat.resumeQueuedCommentInterrupt(companyId, queueId);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
      expect(receipt).toMatchObject({ status: "coalesced" });
      expect(receipt.runId).toBeTruthy();
      const completed = await waitForRun(db, receipt.runId!);
      expect(completed).toMatchObject({ status: "succeeded", responsibleUserId: operatorId });
      expect(completed?.contextSnapshot?.wakeCommentIds).toEqual([commentId]);
      expect(completed?.activeIdentityContextId).toBeTruthy();
      expect(completed?.contextSnapshot?.originIdentityContextId).toBeUndefined();
      expect(completed?.contextSnapshot?.retryOfRunId).toBeUndefined();
      expect(mockAdapterExecute).toHaveBeenCalled();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs.filter(run => run.contextSnapshot?.wakeCommentIds?.includes(commentId))).toHaveLength(1);
      expect(runs.every(run => run.responsibleUserId === operatorId && run.status === "succeeded")).toBe(true);
      expect((await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0].authorUserId).toBe(ownerUserId);
    },
  );

  it.each([
    "agent-authored",
    "run-generated",
    "blank",
    "deleted",
    "missing-author-type",
    "non-user-author-type",
  ] as const)("rejects a persisted %s recovery comment without blocking another agent", async (invalidComment) => {
    const { companyId, agentId: invalidAgentId, ownerUserId } = await seedCompany();
    const validAgentId = randomUUID();
    await db.insert(agents).values({
      id: validAgentId,
      companyId,
      name: "SecondCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });

    const seedPersistedSuccessor = async (
      agentId: string,
      commentShape: "valid" | typeof invalidComment,
    ) => {
      const actorId = `operator-${randomUUID()}`;
      const issueId = randomUUID();
      const commentId = randomUUID();
      const receiptId = randomUUID();
      const sourceRunId = randomUUID();
      const successorRunId = randomUUID();
      const requestId = randomUUID();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId,
        membershipRole: "operator", status: "active" });
      await db.insert(issues).values({ id: issueId, companyId, title: "Persisted interrupt", status: "todo",
        assigneeAgentId: agentId, responsibleUserId: ownerUserId, conversationAgentId: agentId,
        conversationUserId: actorId, conversationState: "active" });
      const acknowledgedAt = new Date();
      const finishedAt = new Date(acknowledgedAt.getTime() + 77);
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, status: "cancelled",
        runtimeMode: "legacy", contextSnapshot: { issueId }, finishedAt,
        resultJson: { queuedCommentInterruptQueueId: receiptId,
          conversationContinuation: "continue_conversation_v1",
          executionCancellation: { state: "acknowledged", forced: false,
            acknowledgedAt: acknowledgedAt.toISOString() } } });
      await db.insert(issueComments).values({ id: commentId, companyId, issueId,
        authorType: commentShape === "missing-author-type" ? null
          : commentShape === "agent-authored" || commentShape === "non-user-author-type" ? "agent" : "user",
        authorAgentId: commentShape === "agent-authored" ? agentId : null,
        authorUserId: commentShape === "agent-authored" ? null : ownerUserId,
        createdByRunId: commentShape === "run-generated" ? sourceRunId : null,
        body: commentShape === "blank" ? " \n\t " : "Resume this conversation",
        deletedAt: commentShape === "deleted" ? new Date() : null });
      await db.insert(agentWakeupRequests).values({ id: receiptId, companyId, agentId,
        source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "system", payload: { issueId, commentId,
          queuedCommentInterrupt: { actorId, requestedAt: new Date().toISOString() },
          _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } } });
      await db.insert(agentWakeupRequests).values({ id: requestId, companyId, agentId,
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "queued",
        requestedByActorType: "user", requestedByActorId: actorId,
        idempotencyKey: `queued-comment-interrupt:${receiptId}`, runId: successorRunId,
        payload: { issueId, commentId } });
      await db.insert(heartbeatRuns).values({ id: successorRunId, companyId, agentId, status: "queued",
        runtimeMode: "legacy", invocationSource: "on_demand", triggerDetail: "manual",
        wakeupRequestId: requestId, responsibleUserId: ownerUserId,
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId],
          conversationSessionGeneration: 0 } });
      return { actorId, issueId, commentId, receiptId, sourceRunId, successorRunId };
    };

    const invalid = await seedPersistedSuccessor(invalidAgentId, invalidComment);
    const valid = await seedPersistedSuccessor(validAgentId, "valid");
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const [invalidRun, validRun, validSourceRun, invalidReceipt, validReceipt] = await Promise.all([
      heartbeat.getRun(invalid.successorRunId),
      heartbeat.getRun(valid.successorRunId),
      heartbeat.getRun(valid.sourceRunId),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, invalid.receiptId)).then(rows => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, valid.receiptId)).then(rows => rows[0]),
    ]);
    expect(invalidRun).toMatchObject({
      status: "failed",
      errorCode: "queued_comment_interrupt_authority_unavailable",
    });
    expect(invalidReceipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(validRun).toMatchObject({ status: "succeeded", responsibleUserId: valid.actorId });
    expect(validRun?.contextSnapshot?.wakeCommentIds).toEqual([valid.commentId]);
    expect(validSourceRun?.resultJson).toMatchObject({
      conversationContinuation: "continue_conversation_v1",
      executionCancellation: { state: "acknowledged", forced: false },
    });
    expect(validSourceRun?.resultJson?.executionRecovery).toBeUndefined();
    expect(validReceipt).toMatchObject({ status: "coalesced", runId: valid.successorRunId });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const recoveryAudit = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.runId, valid.successorRunId),
      eq(activityLog.action, "heartbeat.queued_comment_interrupt_receipt_recovered"),
    ));
    expect(recoveryAudit).toHaveLength(1);
  });

  it.each([
    { name: "matching identity", mismatchedPrimary: false, nullIssueLock: false },
    { name: "mismatched primary actor", mismatchedPrimary: true, nullIssueLock: false },
    { name: "normal queued wake with no issue lock", mismatchedPrimary: false, nullIssueLock: true },
  ])("settles a cancelled successor wake and holds Board receipts for review ($name)", async ({ mismatchedPrimary, nullIssueLock }) => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const actorId = `operator-${randomUUID()}`;
    const issueId = randomUUID(), commentId = randomUUID(), receiptId = randomUUID();
    const sourceRunId = randomUUID(), cancelledRunId = randomUUID(), cancelledWakeId = randomUUID();
    const siblingReceiptId = randomUUID(), mismatchedReceiptId = randomUUID();
    const independentIssueId = randomUUID(), independentRunId = randomUUID(), independentWakeId = randomUUID();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: actorId,
      membershipRole: "operator", status: "active" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Saved Board input", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: ownerUserId,
        conversationAgentId: agentId, conversationUserId: actorId,
        conversationState: "active" },
      { id: independentIssueId, companyId, title: "Independent work", status: "todo",
        assigneeAgentId: agentId, responsibleUserId: ownerUserId },
    ]);
    const acknowledgedAt = new Date(Date.now() - 120_000);
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId,
      status: "cancelled", runtimeMode: "legacy", contextSnapshot: { issueId },
      finishedAt: new Date(acknowledgedAt.getTime() + 50),
      resultJson: { queuedCommentInterruptQueueId: receiptId,
        conversationContinuation: "continue_conversation_v1",
        executionCancellation: { state: "acknowledged", forced: false,
          acknowledgedAt: acknowledgedAt.toISOString() } } });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId,
      authorType: "user", authorUserId: actorId, body: "Continue the conversation" });
    await db.insert(agentWakeupRequests).values([
      { id: receiptId, companyId, agentId, source: "automation", reason: "issue_commented",
        status: "deferred_issue_execution", requestedByActorType: "system",
        payload: { issueId, commentId,
          queuedCommentInterrupt: { actorId: mismatchedPrimary ? ownerUserId : actorId,
            requestedAt: new Date().toISOString() },
          _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } } },
      { id: cancelledWakeId, companyId, agentId, source: "on_demand", triggerDetail: "manual",
        reason: "issue_commented", status: "cancelled", requestedByActorType: "user",
        requestedByActorId: actorId, idempotencyKey: `queued-comment-interrupt:${receiptId}`,
        runId: cancelledRunId, payload: { issueId, commentId } },
      { id: siblingReceiptId, companyId, agentId, source: "on_demand", triggerDetail: "manual",
        reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user",
        requestedByActorId: actorId, idempotencyKey: `queued-comment-interrupt:${receiptId}`,
        runId: sourceRunId,
        payload: { issueId, commentId,
          _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } } },
      { id: mismatchedReceiptId, companyId, agentId, source: "on_demand", triggerDetail: "manual",
        reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user",
        requestedByActorId: ownerUserId, idempotencyKey: `queued-comment-interrupt:${receiptId}`,
        payload: { issueId, commentId,
          _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } } },
      { id: independentWakeId, companyId, agentId, source: "assignment",
        reason: "issue_assigned", status: "queued", requestedByActorType: "system",
        runId: independentRunId, payload: { issueId: independentIssueId } },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: cancelledRunId, companyId, agentId, status: "queued", runtimeMode: "legacy",
        invocationSource: "on_demand", triggerDetail: "manual",
        wakeupRequestId: cancelledWakeId, responsibleUserId: ownerUserId,
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId],
          conversationSessionGeneration: 0 } },
      { id: independentRunId, companyId, agentId, status: "queued", runtimeMode: "legacy",
        invocationSource: "assignment", wakeupRequestId: independentWakeId,
        responsibleUserId: ownerUserId,
        contextSnapshot: { issueId: independentIssueId, wakeReason: "issue_assigned" } },
    ]);
    if (!nullIssueLock) await db.update(issues).set({ executionRunId: cancelledRunId })
      .where(eq(issues.id, issueId));

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await heartbeat.getRun(cancelledRunId)).toMatchObject({
      status: "cancelled", errorCode: "queued_wakeup_terminal" });
    expect(await heartbeat.getRun(independentRunId)).toMatchObject({ status: "succeeded" });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, cancelledWakeId)))[0])
      .toMatchObject({ status: "cancelled" });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId)))[0])
      .toMatchObject({ status: "held_for_board_review", runId: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, siblingReceiptId)))[0])
      .toMatchObject({ status: "held_for_board_review", runId: sourceRunId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, mismatchedReceiptId)))[0])
      .toMatchObject({ status: "held_for_board_review", runId: null });
    const sameKeyBeforeRetry = await db.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `queued-comment-interrupt:${receiptId}`));
    const staleRetry = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: actorId,
      idempotencyKey: `queued-comment-interrupt:${receiptId}`,
      payload: { issueId, commentId },
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] },
    });
    expect(staleRetry).toBeNull();
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `queued-comment-interrupt:${receiptId}`)))
      .toHaveLength(sameKeyBeforeRetry.length);
    const renamedRetry = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: actorId,
      idempotencyKey: `new-key-for-old-comment:${randomUUID()}`,
      payload: { issueId, commentId },
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] },
    });
    expect(renamedRetry).toBeNull();
    const independentCalls = mockAdapterExecute.mock.calls.length;
    expect(independentCalls).toBeGreaterThan(0);

    await db.update(agentWakeupRequests).set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(agentWakeupRequests.id, receiptId));
    await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId));
    expect(receipt).toMatchObject({ status: "held_for_board_review", runId: null });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(independentCalls);
    const sameLineage = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    ));
    expect(sameLineage.filter(run => run.contextSnapshot?.wakeCommentIds?.includes(commentId)
      && run.status === "succeeded")).toHaveLength(0);

    const freshCommentId = randomUUID();
    await db.insert(issueComments).values({ id: freshCommentId, companyId, issueId,
      authorType: "user", authorUserId: actorId, body: "Fresh Board request" });
    const mixedRetry = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: actorId,
      idempotencyKey: `mixed-old-and-new:${randomUUID()}`,
      payload: { issueId, commentId: freshCommentId },
      contextSnapshot: { issueId, wakeReason: "issue_commented",
        wakeCommentIds: [commentId, freshCommentId] },
    });
    expect(mixedRetry).toBeNull();
    const fresh = await heartbeat.wakeup(agentId, {
      manualUserWake: true, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", requestedByActorType: "user", requestedByActorId: actorId,
      payload: { issueId, commentId: freshCommentId },
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentIds: [freshCommentId] },
    });
    expect(fresh).toBeTruthy();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await heartbeat.getRun(fresh!.id)).toMatchObject({
      status: "succeeded", responsibleUserId: actorId });
    expect((await heartbeat.getRun(fresh!.id))?.contextSnapshot?.wakeCommentIds)
      .not.toContain(commentId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId)))[0])
      .toMatchObject({ status: "held_for_board_review", runId: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, siblingReceiptId)))[0])
      .toMatchObject({ status: "held_for_board_review", runId: sourceRunId });

    const plainIssueId = randomUUID(), heldPlainReceiptId = randomUUID(), heldPlainCommentId = randomUUID();
    const blockerRunId = randomUUID(), laterCommentId = randomUUID();
    const laterKey = `later-board-request:${randomUUID()}`;
    await db.insert(issues).values({ id: plainIssueId, companyId,
      title: "New Board request while work is active", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId });
    await db.insert(issueComments).values({ id: heldPlainCommentId, companyId, issueId: plainIssueId,
      authorType: "user", authorUserId: actorId, body: "Held previous request" });
    await db.insert(agentWakeupRequests).values({ id: heldPlainReceiptId, companyId, agentId,
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      status: "held_for_board_review", requestedByActorType: "user", requestedByActorId: actorId,
      payload: { issueId: plainIssueId,
        _paperclipWakeContext: { issueId: plainIssueId, wakeReason: "issue_commented",
          wakeCommentIds: [heldPlainCommentId] } } });
    await db.insert(heartbeatRuns).values({ id: blockerRunId, companyId, agentId,
      status: "running", runtimeMode: "legacy", invocationSource: "on_demand",
      responsibleUserId: actorId, startedAt: new Date(), contextSnapshot: { issueId: plainIssueId } });
    await db.update(issues).set({ executionRunId: blockerRunId,
      executionAgentNameKey: "another-executor" }).where(eq(issues.id, plainIssueId));
    await db.insert(issueComments).values({ id: laterCommentId, companyId, issueId: plainIssueId,
      authorType: "user", authorUserId: actorId, body: "Another fresh Board request" });
    await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: actorId,
      idempotencyKey: laterKey,
      payload: { issueId: plainIssueId, commentId: laterCommentId },
      contextSnapshot: { issueId: plainIssueId, wakeReason: "issue_commented", wakeCommentIds: [laterCommentId] },
    });
    const [later] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, laterKey));
    expect(later).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(later.id).not.toBe(heldPlainReceiptId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, heldPlainReceiptId)))[0])
      .toMatchObject({ status: "held_for_board_review", runId: null });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, blockerRunId));
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null })
      .where(eq(issues.id, plainIssueId));
  });

  it.each(["heartbeat.run.status", "activity.logged"] as const)(
    "commits Board cancellation records and continues queued work when a %s listener throws",
    async failureEvent => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const issueId = randomUUID(), independentIssueId = randomUUID();
    const commentId = randomUUID(), receiptId = randomUUID();
    const terminalRunId = randomUUID(), terminalWakeId = randomUUID();
    const independentRunId = randomUUID(), independentWakeId = randomUUID();
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Saved Board request", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: ownerUserId },
      { id: independentIssueId, companyId, title: "Later queued work", status: "todo",
        assigneeAgentId: agentId, responsibleUserId: ownerUserId },
    ]);
    await db.insert(issueComments).values({ id: commentId, companyId, issueId,
      authorType: "user", authorUserId: ownerUserId, body: "Synthetic saved request" });
    await db.insert(agentWakeupRequests).values([
      { id: receiptId, companyId, agentId, source: "automation", reason: "issue_commented",
        status: "deferred_issue_execution", payload: { issueId, commentId,
          _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } } },
      { id: terminalWakeId, companyId, agentId, source: "on_demand", reason: "issue_commented",
        status: "cancelled", idempotencyKey: `queued-comment-interrupt:${receiptId}`,
        runId: terminalRunId, payload: { issueId, commentId } },
      { id: independentWakeId, companyId, agentId, source: "assignment", reason: "issue_assigned",
        status: "queued", runId: independentRunId, payload: { issueId: independentIssueId } },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: terminalRunId, companyId, agentId, status: "queued", runtimeMode: "legacy",
        invocationSource: "on_demand", wakeupRequestId: terminalWakeId,
        responsibleUserId: ownerUserId, createdAt: new Date(Date.now() - 1_000),
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } },
      { id: independentRunId, companyId, agentId, status: "queued", runtimeMode: "legacy",
        invocationSource: "assignment", wakeupRequestId: independentWakeId,
        responsibleUserId: ownerUserId,
        contextSnapshot: { issueId: independentIssueId, wakeReason: "issue_assigned" } },
    ]);
    await db.update(issues).set({ executionRunId: terminalRunId }).where(eq(issues.id, issueId));

    const seen: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      seen.push({ type: event.type, payload: event.payload });
      if (event.type === failureEvent && event.payload.runId === terminalRunId) {
        throw new Error("synthetic Board listener failure");
      }
    });
    try {
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    } finally {
      unsubscribe();
    }

    const terminalRun = await heartbeat.getRun(terminalRunId);
    expect(terminalRun).toMatchObject({ status: "cancelled", errorCode: "queued_wakeup_terminal",
      executionStatusDeliveryId: expect.any(String), nextEventSeq: 2 });
    expect(await heartbeat.getRun(independentRunId)).toMatchObject({ status: "succeeded" });
    const lifecycle = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, terminalRunId));
    expect(lifecycle).toMatchObject([{ seq: 1, eventType: "lifecycle", stream: "system",
      level: "warn", payload: { code: "queued_wakeup_terminal" } }]);
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "heartbeat.run.event", payload: expect.objectContaining({
        runId: terminalRunId, seq: lifecycle[0].seq, eventType: "lifecycle",
        payload: lifecycle[0].payload, lastEventAt: lifecycle[0].createdAt.toISOString(),
      }),
    })]));
    expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "activity.logged", payload: expect.objectContaining({
        runId: terminalRunId, action: "heartbeat.queued_run_terminal_wake_reconciled",
      }),
    })]));
    for (const action of ["heartbeat.queued_comment_interrupt_held_for_review",
      "heartbeat.queued_run_terminal_wake_reconciled"]) {
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.runId, terminalRunId), eq(activityLog.action, action),
      ))).toHaveLength(1);
    }
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId)))[0])
      .toMatchObject({ status: "held_for_board_review" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBeNull();
    expect(mockAdapterExecute.mock.calls.some(call => call[0].runId === independentRunId)).toBe(true);
    expect(mockAdapterExecute.mock.calls.some(call => call[0].runId === terminalRunId)).toBe(false);
    await heartbeat.resumeQueuedRuns();
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, terminalRunId)))
      .toHaveLength(1);
    },
  );

  it("serializes a held receipt transition with fresh same-issue Board admission", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const issueId = randomUUID(), heldCommentId = randomUUID(), freshCommentId = randomUUID();
    const receiptId = randomUUID(), terminalWakeId = randomUUID(), terminalRunId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Board race",
      status: "in_progress", assigneeAgentId: agentId, responsibleUserId: ownerUserId });
    await db.insert(issueComments).values([
      { id: heldCommentId, companyId, issueId, authorType: "user", authorUserId: ownerUserId,
        body: "Saved input with ambiguous cancellation" },
      { id: freshCommentId, companyId, issueId, authorType: "user", authorUserId: ownerUserId,
        body: "Fresh authorized Board request" },
    ]);
    await db.insert(agentWakeupRequests).values([
      { id: receiptId, companyId, agentId, source: "on_demand", reason: "issue_commented",
        status: "deferred_issue_execution", requestedByActorType: "user",
        requestedByActorId: ownerUserId,
        payload: { issueId, commentId: heldCommentId,
          _paperclipWakeContext: { issueId, wakeReason: "issue_commented",
            wakeCommentIds: [heldCommentId] } } },
      { id: terminalWakeId, companyId, agentId, source: "on_demand", reason: "issue_commented",
        status: "cancelled", idempotencyKey: `queued-comment-interrupt:${receiptId}`,
        runId: terminalRunId, payload: { issueId, commentId: heldCommentId } },
    ]);
    await db.insert(heartbeatRuns).values({ id: terminalRunId, companyId, agentId,
      status: "queued", runtimeMode: "legacy", invocationSource: "on_demand",
      wakeupRequestId: terminalWakeId, responsibleUserId: ownerUserId,
      contextSnapshot: { issueId, wakeReason: "issue_commented",
        wakeCommentIds: [heldCommentId] } });

    const advisoryKey = 178913124;
    await db.execute(sql.raw(`
      CREATE FUNCTION pause_board_receipt_hold() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${receiptId}'::uuid AND NEW.status = 'held_for_board_review' THEN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER pause_board_receipt_hold BEFORE UPDATE OF status
      ON agent_wakeup_requests FOR EACH ROW EXECUTE FUNCTION pause_board_receipt_hold();
    `));
    let releaseGate!: () => void;
    let signalGateReady!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const gateReady = new Promise<void>((resolve) => { signalGateReady = resolve; });
    const lockHolder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey})`);
      signalGateReady();
      await gate;
    });
    await gateReady;
    let settling: Promise<unknown> | null = null;
    try {
      settling = heartbeat.resumeQueuedRuns();
      let holdCasPaused = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const [waiting] = await db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted`);
        if (Number(waiting?.waiting ?? 0) > 0) { holdCasPaused = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(holdCasPaused).toBe(true);
      let freshFinished = false;
      const freshWake = heartbeat.wakeup(agentId, {
        manualUserWake: true, source: "on_demand", triggerDetail: "manual",
        reason: "issue_commented", requestedByActorType: "user",
        requestedByActorId: ownerUserId,
        payload: { issueId, commentId: freshCommentId },
        contextSnapshot: { issueId, wakeReason: "issue_commented",
          wakeCommentIds: [freshCommentId] },
      }).then((run) => { freshFinished = true; return run; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(freshFinished).toBe(false);
      releaseGate();
      const [, freshRun] = await Promise.all([settling, freshWake]);
      expect(freshRun).toBeTruthy();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect((await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, receiptId)))[0]).toMatchObject({
          status: "held_for_board_review", runId: null,
        });
      expect(await heartbeat.getRun(terminalRunId)).toMatchObject({ status: "cancelled" });
      expect(await heartbeat.getRun(freshRun!.id)).toMatchObject({ status: "succeeded" });
      expect((await heartbeat.getRun(freshRun!.id))?.contextSnapshot?.wakeCommentIds)
        .toEqual([freshCommentId]);
      const succeededRuns = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "succeeded")));
      expect(succeededRuns.some((run) => run.contextSnapshot?.wakeCommentIds?.includes(heldCommentId)))
        .toBe(false);
    } finally {
      releaseGate();
      await lockHolder;
      await settling?.catch(() => {});
      await db.execute(sql`DROP TRIGGER IF EXISTS pause_board_receipt_hold ON agent_wakeup_requests`);
      await db.execute(sql`DROP FUNCTION IF EXISTS pause_board_receipt_hold()`);
    }
  });

  it.each(["missing", "wrong", "conflicting_checkout", "same_issue_checkout_other_run"] as const)(
    "holds a terminal Board successor with %s run issue identity without dispatch or release",
    async (mode) => {
      const { companyId, agentId, ownerUserId } = await seedCompany();
      const issueId = randomUUID(), wrongIssueId = randomUUID();
      const runId = randomUUID(), wakeId = randomUUID(), receiptId = randomUUID();
      const commentId = randomUUID();
      await db.insert(issues).values([
        { id: issueId, companyId, title: "Bound issue", status: "todo",
          assigneeAgentId: agentId, responsibleUserId: ownerUserId },
        { id: wrongIssueId, companyId, title: "Different issue", status: "todo",
          assigneeAgentId: agentId, responsibleUserId: ownerUserId },
      ]);
      await db.insert(issueComments).values({ id: commentId, companyId, issueId,
        authorType: "user", authorUserId: ownerUserId, body: "Saved Board input" });
      await db.insert(agentWakeupRequests).values([
        { id: receiptId, companyId, agentId, source: "on_demand", reason: "issue_commented",
          status: "deferred_issue_execution", requestedByActorType: "user",
          requestedByActorId: ownerUserId,
          payload: { issueId, commentId,
            queuedCommentInterrupt: { actorId: ownerUserId },
            _paperclipWakeContext: { issueId, wakeReason: "issue_commented",
              wakeCommentIds: [commentId] } } },
        { id: wakeId, companyId, agentId, source: "on_demand", triggerDetail: "manual",
          reason: "issue_commented", status: "cancelled", requestedByActorType: "user",
          requestedByActorId: ownerUserId,
          idempotencyKey: `queued-comment-interrupt:${receiptId}`,
          runId, payload: { issueId, commentId } },
      ]);
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
        status: "queued", runtimeMode: "legacy", invocationSource: "on_demand",
        triggerDetail: "manual", wakeupRequestId: wakeId, responsibleUserId: ownerUserId,
        contextSnapshot: { ...(mode === "missing" ? {} : {
          issueId: mode === "wrong" ? wrongIssueId : issueId }),
          wakeReason: "issue_commented", wakeCommentIds: [commentId] } });
      if (mode === "conflicting_checkout") {
        await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, wrongIssueId));
      } else if (mode === "same_issue_checkout_other_run") {
        const otherRunId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: otherRunId, companyId, agentId,
          status: "succeeded", runtimeMode: "legacy", invocationSource: "on_demand",
          finishedAt: new Date(), contextSnapshot: { issueId } });
        await db.update(issues).set({ executionRunId: runId, checkoutRunId: otherRunId })
          .where(eq(issues.id, issueId));
      } else {
        await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      }

      await heartbeat.resumeQueuedRuns();
      await heartbeat.resumeQueuedRuns();
      expect(await heartbeat.getRun(runId)).toMatchObject({
        status: "queued", errorCode: "queued_wakeup_issue_identity_unverified" });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
        eq(activityLog.action, "heartbeat.queued_board_interrupt_issue_identity_unverified"))))
        .toHaveLength(1);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId)
        .toBe(mode === "conflicting_checkout" ? null : runId);
      if (mode === "conflicting_checkout") {
        expect((await db.select().from(issues).where(eq(issues.id, wrongIssueId)))[0].checkoutRunId)
          .toBe(runId);
      } else if (mode === "same_issue_checkout_other_run") {
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].checkoutRunId)
          .not.toBeNull();
      }
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    },
  );

  it.each(["missing_primary", "wrong_primary_issue", "claimed_primary", "controller_owned", "malformed_key", "provider_session_owned", "native_session_owned", "output_owned", "output_stream_owned", "compressed_log_owned", "lease_owned", "lease_removed_after_hold"] as const)(
    "leaves an unverified terminal Board successor for review (%s)", async (mode) => {
      const { companyId, agentId, ownerUserId } = await seedCompany();
      const issueId = randomUUID(), receiptId = randomUUID(), runId = randomUUID();
      const wakeId = randomUUID(), commentId = randomUUID();
      const retainedExecution = mode === "provider_session_owned" || mode === "native_session_owned" ||
        mode === "output_owned" || mode === "output_stream_owned" || mode === "compressed_log_owned" ||
        mode === "lease_owned" || mode === "lease_removed_after_hold";
      await db.insert(issues).values({ id: issueId, companyId, title: "Saved Board request",
        status: "todo", assigneeAgentId: agentId, responsibleUserId: ownerUserId });
      await db.insert(issueComments).values({ id: commentId, companyId, issueId,
        authorType: "user", authorUserId: ownerUserId, body: "Saved Board input" });
      if (mode !== "missing_primary") await db.insert(agentWakeupRequests).values({
        id: receiptId, companyId, agentId, source: "on_demand", reason: "issue_commented",
        status: mode === "claimed_primary" ? "claimed" : "deferred_issue_execution",
        payload: { issueId: mode === "wrong_primary_issue" ? randomUUID() : issueId, commentId,
          _paperclipWakeContext: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } },
      });
      await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId,
        source: "on_demand", reason: "issue_commented", status: "cancelled",
        idempotencyKey: mode === "malformed_key"
          ? "queued-comment-interrupt:not-a-uuid" : `queued-comment-interrupt:${receiptId}`,
        runId, payload: { issueId, commentId } });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId,
        status: "queued", runtimeMode: "legacy", invocationSource: "on_demand",
        wakeupRequestId: wakeId, responsibleUserId: ownerUserId,
        startedAt: mode === "controller_owned" ? new Date() : null,
        sessionIdAfter: mode === "provider_session_owned" ? "retained-provider-session" : null,
        nativeSessionId: mode === "native_session_owned" ? randomUUID() : null,
        lastOutputAt: mode === "output_owned" ? new Date() : null,
        lastOutputSeq: mode === "output_owned" ? 1 : 0,
        lastOutputStream: mode === "output_stream_owned" ? "stdout" : null,
        logCompressed: mode === "compressed_log_owned",
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } });
      if (retainedExecution) {
        await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      }
      if (mode === "lease_owned" || mode === "lease_removed_after_hold") await db.insert(environmentLeases).values({
        companyId, issueId, heartbeatRunId: runId, status: "active", provider: "test", providerLeaseId: "retained-lease",
      });
      await heartbeat.resumeQueuedRuns();
      expect(await heartbeat.getRun(runId)).toMatchObject({ status: "queued" });
      if (!retainedExecution && mode !== "controller_owned") {
        await heartbeat.resumeQueuedRuns();
        expect(await heartbeat.getRun(runId)).toMatchObject({ status: "queued",
          errorCode: "queued_wakeup_receipt_unverified" });
        expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
          eq(activityLog.action, "heartbeat.queued_board_interrupt_receipt_unverified"))))
          .toHaveLength(1);
      }
      if (retainedExecution) {
        if (mode === "lease_removed_after_hold") {
          expect(await heartbeat.getRun(runId)).toMatchObject({
            errorCode: "queued_wakeup_execution_ownership_unverified" });
          await db.delete(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
        }
        await heartbeat.resumeQueuedRuns();
        expect(await heartbeat.getRun(runId)).toMatchObject({ status: "queued",
          errorCode: "queued_wakeup_execution_ownership_unverified" });
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(runId);
        expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
          eq(activityLog.action, "heartbeat.queued_board_interrupt_execution_ownership_unverified"))))
          .toHaveLength(1);
      }
      if (mode === "provider_session_owned") {
        expect(await heartbeat.getRun(runId)).toMatchObject({ sessionIdAfter: "retained-provider-session" });
      } else if (mode === "native_session_owned") {
        expect((await heartbeat.getRun(runId))?.nativeSessionId).not.toBeNull();
      } else if (mode === "output_owned") {
        expect(await heartbeat.getRun(runId)).toMatchObject({ lastOutputSeq: 1 });
      } else if (mode === "output_stream_owned") {
        expect(await heartbeat.getRun(runId)).toMatchObject({ lastOutputStream: "stdout" });
      } else if (mode === "compressed_log_owned") {
        expect(await heartbeat.getRun(runId)).toMatchObject({ logCompressed: true });
      } else if (mode === "lease_owned") {
        expect((await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId)))[0])
          .toMatchObject({ status: "active", providerLeaseId: "retained-lease" });
      }
      if (mode !== "missing_primary") {
        expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId)))[0])
          .toMatchObject({ status: mode === "claimed_primary" ? "claimed" : "deferred_issue_execution" });
      }
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    },
  );

  it.each(["startup", "periodic"] as const)(
    "coalesces a historical same-lineage duplicate during %s queued-run recovery",
    async (recoveryKind) => {
      const { companyId, agentId, ownerUserId } = await seedCompany();
      const actorId = `operator-${randomUUID()}`;
      const issueId = randomUUID();
      const commentId = randomUUID();
      const receiptId = randomUUID();
      const siblingReceiptId = randomUUID();
      const sourceRunId = randomUUID();
      const successorRunId = randomUUID();
      const requestId = randomUUID();
      const idempotencyKey = `queued-comment-interrupt:${receiptId}`;
      const acknowledgedAt = new Date();
      const finishedAt = new Date(acknowledgedAt.getTime() + 50);
      const wakeContext = {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentIds: [commentId],
      };

      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: actorId,
        membershipRole: "operator",
        status: "active",
      });
      await instanceSettingsService(db).updateExperimental({
        enableAgentChat: true,
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Persisted duplicate interrupt receipt",
        status: "todo",
        assigneeAgentId: agentId,
        responsibleUserId: ownerUserId,
        conversationAgentId: agentId,
        conversationUserId: actorId,
        conversationState: "active",
      });
      await db.insert(issueComments).values({
        id: commentId,
        companyId,
        issueId,
        authorType: "user",
        authorUserId: ownerUserId,
        body: "Recover this follow-up exactly once",
      });
      await db.insert(heartbeatRuns).values({
        id: sourceRunId,
        companyId,
        agentId,
        status: "cancelled",
        runtimeMode: "legacy",
        contextSnapshot: { issueId },
        finishedAt,
        resultJson: {
          queuedCommentInterruptQueueId: receiptId,
          conversationContinuation: "continue_conversation_v1",
          executionCancellation: {
            state: "acknowledged",
            forced: false,
            acknowledgedAt: acknowledgedAt.toISOString(),
          },
        },
      });
      await db.insert(agentWakeupRequests).values([
        {
          id: receiptId,
          companyId,
          agentId,
          source: "automation",
          reason: "issue_commented",
          status: "deferred_issue_execution",
          requestedByActorType: "system",
          payload: {
            issueId,
            commentId,
            queuedCommentInterrupt: {
              actorId,
              requestedAt: acknowledgedAt.toISOString(),
            },
            _paperclipWakeContext: wakeContext,
          },
        },
        {
          id: siblingReceiptId,
          companyId,
          agentId,
          source: "on_demand",
          triggerDetail: "manual",
          reason: "issue_commented",
          status: "deferred_issue_execution",
          requestedByActorType: "user",
          requestedByActorId: actorId,
          idempotencyKey,
          payload: {
            issueId,
            commentId,
            _paperclipWakeContext: wakeContext,
          },
        },
        {
          id: requestId,
          companyId,
          agentId,
          source: "on_demand",
          triggerDetail: "manual",
          reason: "issue_commented",
          status: "queued",
          requestedByActorType: "user",
          requestedByActorId: actorId,
          idempotencyKey,
          runId: successorRunId,
          payload: { issueId, commentId },
        },
      ]);
      await db.insert(heartbeatRuns).values({
        id: successorRunId,
        companyId,
        agentId,
        status: "queued",
        runtimeMode: "legacy",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        wakeupRequestId: requestId,
        responsibleUserId: ownerUserId,
        contextSnapshot: wakeContext,
      });

      const recovery =
        recoveryKind === "startup" ? heartbeatService(db) : heartbeat;
      await recovery.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, recovery);
      await recovery.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, recovery);

      const [runs, receipts, audits] = await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
        db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
        db.select().from(activityLog).where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "heartbeat.queued_comment_interrupt_receipt_recovered"),
        )),
      ]);
      expect(runs).toHaveLength(2);
      expect(runs).not.toContainEqual(expect.objectContaining({ status: "failed" }));
      expect(runs.find((run) => run.id === successorRunId)).toMatchObject({
        status: "succeeded",
        responsibleUserId: actorId,
        contextSnapshot: expect.objectContaining({ wakeCommentIds: [commentId] }),
      });
      expect(
        receipts.filter((receipt) =>
          [receiptId, siblingReceiptId].includes(receipt.id),
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: receiptId, status: "coalesced", runId: successorRunId }),
          expect.objectContaining({ id: siblingReceiptId, status: "coalesced", runId: successorRunId }),
        ]),
      );
      expect(
        receipts.filter(
          (receipt) => receipt.status === "deferred_issue_execution",
        ),
      ).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.details).toMatchObject({
        receiptId,
        sourceRunId,
        coalescedSiblingReceiptIds: [siblingReceiptId],
      });
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a board manual wake under its caller even when it adopts someone else's queue", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const operatorId = `operator-${randomUUID()}`, issueId = randomUUID(), commentId = randomUUID(), queueId = randomUUID();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: operatorId,
      membershipRole: "operator", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Manual wake", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: ownerUserId, body: "Pending work" });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: ownerUserId,
      payload: { issueId, commentId, _paperclipWakeContext: { wakeCommentIds: [commentId] } },
    });
    const run = await heartbeat.wakeup(agentId, { manualUserWake: true, source: "on_demand", triggerDetail: "manual",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: operatorId,
      contextSnapshot: { responsibleUserId: operatorId } });
    expect(run?.responsibleUserId).toBe(operatorId);
    const completed = await waitForRun(db, run!.id);
    expect(completed).toMatchObject({ status: "succeeded", responsibleUserId: operatorId });
    expect(completed?.contextSnapshot?.wakeCommentIds).toEqual([commentId]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect((await db.select().from(heartbeatRuns)).every(row => row.responsibleUserId === operatorId)).toBe(true);
  });

  it("keeps the clicking user when a manual wake merges into an older deferred receipt", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const operatorId = `operator-${randomUUID()}`, issueId = randomUUID(), commentId = randomUUID(), queueId = randomUUID();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: operatorId,
      membershipRole: "operator", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deferred manual wake", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId });
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const execute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementationOnce(async () => { await blocked; return execute(); });
    const first = await heartbeat.wakeup(agentId, { payload: { issueId },
      requestedByActorType: "user", requestedByActorId: ownerUserId });
    try {
      await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalled(), { timeout: 5_000 });
      await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: ownerUserId, body: "Pending work" });
      await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId,
        source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: ownerUserId,
        payload: { issueId, commentId, _paperclipWakeContext: { wakeCommentIds: [commentId] } },
      });
      expect(await heartbeat.wakeup(agentId, { manualUserWake: true, source: "on_demand", triggerDetail: "manual",
        payload: { issueId }, requestedByActorType: "user", requestedByActorId: operatorId,
        contextSnapshot: { responsibleUserId: operatorId } })).toBeNull();
      const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId));
      expect(pending).toMatchObject({ requestedByActorType: "user", requestedByActorId: operatorId,
        payload: { manualUserWake: true } });
    } finally {
      finish();
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const successors = (await db.select().from(heartbeatRuns)).filter(run => run.id !== first!.id);
    expect(successors.length).toBeGreaterThan(0);
    expect(successors.every(run => run.responsibleUserId === operatorId && run.status === "succeeded")).toBe(true);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0].authorUserId).toBe(ownerUserId);
  });

  it("starts an unscoped manual wake with its own user instead of joining another user's run", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const operatorId = `operator-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: operatorId,
      membershipRole: "operator", status: "active" });
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const execute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementationOnce(async () => { await blocked; return execute(); });
    const first = await heartbeat.wakeup(agentId, { manualUserWake: true, source: "on_demand", triggerDetail: "manual",
      requestedByActorType: "user", requestedByActorId: ownerUserId });
    let second: Awaited<ReturnType<typeof heartbeat.wakeup>>;
    try {
      await vi.waitFor(() => expect(mockAdapterExecute).toHaveBeenCalled(), { timeout: 5_000 });
      second = await heartbeat.wakeup(agentId, { manualUserWake: true, source: "on_demand", triggerDetail: "manual",
        requestedByActorType: "user", requestedByActorId: operatorId });
      expect(second?.id).not.toBe(first!.id);
      expect(second?.responsibleUserId).toBe(operatorId);
    } finally {
      finish();
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await waitForRun(db, second!.id)).toMatchObject({ status: "succeeded", responsibleUserId: operatorId });
    expect(await waitForRun(db, first!.id)).toMatchObject({ status: "succeeded", responsibleUserId: ownerUserId });
  });

  it("denies a manual wake of another user's private conversation", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Private conversation", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId, conversationAgentId: agentId, conversationUserId: ownerUserId, conversationState: "active" });
    await expect(heartbeat.wakeup(agentId, { manualUserWake: true, source: "on_demand", triggerDetail: "manual",
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "another-user" })).rejects.toThrow("conversation owner");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });

  it("does not accept a caller-supplied manual-wake authority marker", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual",
      requestedByActorType: "agent", requestedByActorId: agentId, payload: { manualUserWake: true },
      contextSnapshot: { responsibleUserId: ownerUserId } });
    expect((await waitForRun(db, run!.id))?.status).toBe("succeeded");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run!.wakeupRequestId!));
    expect(wake.payload?.manualUserWake).toBeUndefined();
  });

  it("uses the issue responsible user for automated dependency wakes without a message context", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueResponsibleUserId = `issue-owner-${randomUUID()}`;
    const commenterUserId = `commenter-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue-owned work",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: issueResponsibleUserId,
    });

    const sourceRunIds: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
      const wakeReason = "issue_blockers_resolved";
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: wakeReason,
        payload: { issueId },
        requestedByActorType: "user",
        requestedByActorId: commenterUserId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason },
      });
      expect(run).not.toBeNull();
      sourceRunIds.push(run!.id);
      const completed = await waitForRun(db, run!.id);
      expect(completed?.responsibleUserId).toBe(issueResponsibleUserId);
      expect(completed?.status).toBe("succeeded");
      // A terminal row can precede the execution's final queue/lease cleanup.
      // This test starts independent wakes, not a burst that may be deferred.
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
    // The deliberately disposition-free adapter response schedules one bounded
    // repair per source run; the fixture records done on repair. Each retains its identity.
    const runs = await db.select().from(heartbeatRuns);
    const handoffs = runs.filter((run) => !sourceRunIds.includes(run.id));
    expect(handoffs).toHaveLength(3);
    expect(
      handoffs.map((run) => run.contextSnapshot?.retryOfRunId).sort(),
    ).toEqual(sourceRunIds.sort());
    for (const handoff of handoffs) {
      expect(handoff.contextSnapshot?.wakeReason).toBe(
        "issue_disposition_repair",
      );
      expect(handoff.responsibleUserId).toBe(issueResponsibleUserId);
      expect(handoff.status).toBe("succeeded");
    }
    expect(mockAdapterExecute).toHaveBeenCalledTimes(runs.length);
  });

  it.each(["issue_commented", "issue_comment_mentioned"])(
    "uses the persisted message author for %s without changing issue ownership",
    async (wakeReason) => {
      const { companyId, agentId } = await seedCompany();
      const issueResponsibleUserId = `issue-owner-${randomUUID()}`;
      const commenterUserId = `commenter-${randomUUID()}`;
      const issueId = randomUUID();
      const commentId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Message-authored work",
        status: "todo",
        assigneeAgentId: agentId,
        responsibleUserId: issueResponsibleUserId,
      });
      await db.insert(issueComments).values({
        id: commentId,
        companyId,
        issueId,
        authorUserId: commenterUserId,
        body: `Current request for ${wakeReason}`,
      });

      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: wakeReason,
        payload: { issueId, commentId },
        // Request metadata is not authority to replace the stored author.
        requestedByActorType: "user",
        requestedByActorId: `different-requester-${randomUUID()}`,
        contextSnapshot: { issueId, taskId: issueId, wakeReason },
      });

      expect(run).not.toBeNull();
      const completed = await waitForRun(db, run!.id);
      expect(completed?.status).toBe("succeeded");
      expect(completed?.responsibleUserId).toBe(commenterUserId);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.responsibleUserId).toBe(issueResponsibleUserId);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs.every(row => row.responsibleUserId === commenterUserId)).toBe(true);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(runs.length);
    },
  );

  it("uses the triggering user for manual UI/API runs", async () => {
    const { agentId } = await seedCompany();
    const triggeringUserId = `manual-${randomUUID()}`;
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: triggeringUserId,
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(triggeringUserId);
  });

  it("falls back to the company default for system-originated runs without an issue", async () => {
    const { agentId, ownerUserId } = await seedCompany();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "scheduled_maintenance",
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: { wakeReason: "scheduled_maintenance" },
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
  });

  it("does not use an issue creator as an implicit responsible user for automated issue runs", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const creatorUserId = `creator-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator is not credential owner",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: creatorUserId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_blockers_resolved" },
    });
    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
    expect(completed?.responsibleUserId).not.toBe(creatorUserId);
  });

  it("fails automated issue dispatch instead of falling back to the issue creator when no default exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Creator-only",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator-only issue",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: `creator-${randomUUID()}`,
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });

  it("fails dispatch before creating a run when no responsible user can be resolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ownerless",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      requestedByActorType: "system",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });
});

import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { recoveryService } from "../services/recovery/service.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, approvals, companies, createDb, heartbeatRuns, issueApprovals,
  issueRecoveryActions, issueRelations, issueThreadInteractions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { revisionReconciliation } from "../services/recovery/revision-reconciliation.js";
import { REVISION_ATTEMPT_ACTIVITY, REVISION_OUTCOME_ACTIVITY } from "../services/recovery/revision-outcome.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("durable adapter-independent revision reconciliation", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("revision-outcomes-"); db = createDb(temp.connectionString); }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function seed(adapterType = "codex_local") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), approvalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Revision Test", issuePrefix: `R${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle", adapterType,
      adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Revise proposal", status: "todo", priority: "medium", assigneeAgentId: agentId });
    await db.insert(approvals).values({ id: approvalId, companyId, type: "request_board_approval", status: "revision_requested",
      requestedByAgentId: agentId, payload: { title: "Proposal" }, decidedAt: new Date(Date.now() - 60 * 60_000) });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    return { companyId, agentId, issueId, approvalId };
  }
  async function events(id: string, action = REVISION_OUTCOME_ACTIVITY) {
    return db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, action))).orderBy(activityLog.createdAt);
  }
  async function latest(id: string) { return (await events(id)).at(-1)!.details!; }
  async function deferOldAttempts(id: string) {
    await db.update(activityLog).set({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) })
      .where(and(eq(activityLog.entityId, id), eq(activityLog.action, REVISION_ATTEMPT_ACTIVITY)));
  }
  it.each([...AGENT_ADAPTER_TYPES, "external_test_adapter"])
    ("recovers skipped/failed delivery and successful no-op for %s without adapter branches", async adapter => {
      const x = await seed(adapter);
      await db.insert(heartbeatRuns).values({ companyId: x.companyId, agentId: x.agentId, status: "succeeded",
        invocationSource: "automation", triggerDetail: "system", contextSnapshot: { issueId: x.issueId, approvalId: x.approvalId },
        finishedAt: new Date() });
      const enqueue = vi.fn(async () => null);
      await revisionReconciliation(db, enqueue).reconcile();
      expect(enqueue.mock.calls.some(call => call[0] === x.agentId)).toBe(true);
      expect(await latest(x.approvalId)).toMatchObject({ outcome: "unresolved", attemptCount: 1 });
      expect((await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY))).toHaveLength(1);
      await revisionReconciliation(db, enqueue).reconcile();
      expect((await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY))).toHaveLength(1);
    });
  it.each(["skipped", "failed", "cancelled"])("recovers persisted %s delivery", async status => {
    const x = await seed();
    await db.insert(agentWakeupRequests).values({ companyId: x.companyId, agentId: x.agentId,
      source: "automation", reason: "approval_revision_requested", status, payload: { issueId: x.issueId, approvalId: x.approvalId } });
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(1);
  });
  it("does not reserve a cancelled card with no revision history", async () => {
    const x = await seed(); const enqueue = vi.fn(async () => null);
    await db.update(approvals).set({ status: "cancelled" }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, enqueue).reconcile();
    expect(await events(x.approvalId)).toHaveLength(0);
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    expect(enqueue.mock.calls.filter(call => call[0] === x.agentId)).toHaveLength(0);
  });
  it.each([false, true])("settles cancellation without retrying or recreating exhausted intervention (%s)", async exhausted => {
    const x = await seed(); const enqueue = vi.fn(async () => null);
    await revisionReconciliation(db, enqueue).reconcile();
    if (exhausted) {
      for (let i = 0; i < 3; i++) {
        await deferOldAttempts(x.approvalId);
        await revisionReconciliation(db, enqueue).reconcile();
      }
      expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker", attemptCount: 3 });
    }
    const before = await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY);
    const callsBefore = enqueue.mock.calls.filter(call => call[0] === x.agentId).length;
    await db.update(approvals).set({ status: "cancelled" }).where(eq(approvals.id, x.approvalId));
    await deferOldAttempts(x.approvalId);
    await revisionReconciliation(db, enqueue).reconcile();
    await revisionReconciliation(db, enqueue).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(before.length);
    expect(enqueue.mock.calls.filter(call => call[0] === x.agentId)).toHaveLength(callsBefore);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "disposed", blocker: null, nextFollowUpAt: null });
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, x.issueId));
    expect(actions.filter(action => ["active", "escalated"].includes(action.status))).toHaveLength(0);
  });
  it("preserves unrelated recovery actions on cancellation", async () => {
    const x = await seed();
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: x.companyId, sourceIssueId: x.issueId,
      kind: "stranded_assigned_issue", ownerType: "board", cause: "other_cause", fingerprint: "unrelated",
      nextAction: "Preserve this action", status: "active" }).returning();
    await db.update(approvals).set({ status: "cancelled" }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(after).toEqual(action);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "disposed", blocker: null });
  });
  it("recovers a requester-owned issue blocked solely on this revision once", async () => {
    const x = await seed(); const enqueue = vi.fn(async () => null);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, x.issueId));
    await revisionReconciliation(db, enqueue).reconcile();
    await revisionReconciliation(db, enqueue).reconcile();
    const calls = enqueue.mock.calls.filter(call => call[0] === x.agentId);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ reason: "approval_revision_requested",
      issueStateGuard: { statuses: ["todo", "in_progress", "blocked"], assigneeAgentId: x.agentId },
      contextSnapshot: { approvalId: x.approvalId, approvalStatus: "revision_requested", issueId: x.issueId } });
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, x.issueId));
    expect(issue.status).toBe("blocked");
  });
  it.each(["dependency", "cancelled_dependency", "interaction", "approval", "owner", "unblock_descriptor"])("preserves blocked issue with unrelated %s", async kind => {
    const x = await seed(); const enqueue = vi.fn(async () => null);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, x.issueId));
    if (kind === "dependency" || kind === "cancelled_dependency") {
      const id = randomUUID();
      await db.insert(issues).values({ id, companyId: x.companyId, title: "Required prerequisite", status: kind === "dependency" ? "todo" : "cancelled" });
      await db.insert(issueRelations).values({ companyId: x.companyId, issueId: id, relatedIssueId: x.issueId, type: "blocks" });
    } else if (kind === "interaction") {
      await db.insert(issueThreadInteractions).values({ companyId: x.companyId, issueId: x.issueId,
        kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee", payload: { title: "Human decision" } });
    } else if (kind === "approval") {
      const id = randomUUID();
      await db.insert(approvals).values({ id, companyId: x.companyId, type: "request_board_approval", status: "revision_requested",
        requestedByAgentId: x.agentId, payload: {}, decidedAt: new Date() });
      await db.insert(issueApprovals).values({ companyId: x.companyId, issueId: x.issueId, approvalId: id });
    } else if (kind === "unblock_descriptor") {
      await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Authorize prerequisite" } }).where(eq(issues.id, x.issueId));
    } else {
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, x.issueId));
    }
    await revisionReconciliation(db, enqueue).reconcile();
    expect(enqueue.mock.calls.filter(call => call[0] === x.agentId)).toHaveLength(0);
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker" });
  });
  it("is wired into the existing sweep without a competing generic continuation", async () => {
    const x = await seed(); const enqueue = vi.fn(async () => null);
    await recoveryService(db, { enqueueWakeup: enqueue }).reconcileStrandedAssignedIssues();
    expect(enqueue.mock.calls.filter(call => call[0] === x.agentId)).toHaveLength(1);
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(1);
  });
  it.each(["queued", "running", "scheduled_retry"])("preserves an existing %s run", async status => {
    const x = await seed();
    await db.insert(heartbeatRuns).values({ companyId: x.companyId, agentId: x.agentId,
      status, invocationSource: "automation", triggerDetail: "system", contextSnapshot: { issueId: x.issueId } });
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "unresolved", executionActive: true });
  });
  it("does not choose an arbitrary primary issue from multiple links", async () => {
    const x = await seed(), secondId = randomUUID();
    await db.insert(issues).values({ id: secondId, companyId: x.companyId, title: "Another link", status: "done" });
    await db.insert(issueApprovals).values({ companyId: x.companyId, issueId: secondId, approvalId: x.approvalId });
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker", missingOwner: true });
  });
  it("resolves its own exhausted action on resubmission without rewriting approval decisions", async () => {
    const x = await seed();
    await db.update(approvals).set({ decidedAt: new Date(Date.now() - 25 * 60 * 60_000) }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker" });
    await db.update(approvals).set({ status: "pending", decidedAt: null }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "resubmitted", blocker: null });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, x.issueId));
    expect(action.status).toBe("resolved");
    const [card] = await db.select().from(approvals).where(eq(approvals.id, x.approvalId));
    expect(card.status).toBe("pending"); expect(card.payload).toEqual({ title: "Proposal" });
  });
  it("serializes independent sweep instances and retains the cap across restarts and admission errors", async () => {
    const x = await seed();
    const enqueue = vi.fn(async () => { throw new Error("admission failed"); });
    await Promise.all([revisionReconciliation(db, enqueue).reconcile(), revisionReconciliation(db, enqueue).reconcile()]);
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(1);
    for (let i = 0; i < 3; i++) { await deferOldAttempts(x.approvalId); await revisionReconciliation(db, enqueue).reconcile(); }
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(3);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker", attemptCount: 3 });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, x.issueId));
    expect(action).toMatchObject({ ownerType: "board", cause: "approval_revision_unresolved", attemptCount: 3 });
  });
  it("records actual resubmission and disposition, and resets only for a new decision", async () => {
    const x = await seed(); const enqueue = vi.fn(async () => null);
    await revisionReconciliation(db, enqueue).reconcile();
    await db.update(approvals).set({ status: "pending", decidedAt: null }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, enqueue).reconcile();
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "resubmitted" });
    await db.update(approvals).set({ status: "approved", decidedAt: new Date() }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, enqueue).reconcile();
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "disposed" });
    await db.update(approvals).set({ status: "revision_requested", decidedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, enqueue).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(2);
  });
  it("preserves human-only pending interactions and unchanged durable blockers", async () => {
    const x = await seed(); const enqueue = vi.fn(async () => null); const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: x.companyId, issueId: x.issueId,
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee", payload: { title: "Human decision" } });
    await revisionReconciliation(db, enqueue).reconcile();
    await revisionReconciliation(db, enqueue).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker", blocker: `interaction:${interactionId}` });
    expect(await events(x.approvalId)).toHaveLength(1);
  });
  it("does not reopen linked-done issues or steal a changed owner", async () => {
    for (const status of ["done", "cancelled"] as const) {
      const x = await seed(); await db.update(issues).set({ status }).where(eq(issues.id, x.issueId));
      await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
      expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
      expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker", missingOwner: true });
      const [issue] = await db.select().from(issues).where(eq(issues.id, x.issueId));
      expect(issue.status).toBe(status); expect(issue.assigneeAgentId).toBe(x.agentId);
    }
  });
  it("keeps paused/archived companies out and ignores malicious cross-company links", async () => {
    for (const status of ["paused", "archived"]) {
      const x = await seed(); await db.update(companies).set({ status }).where(eq(companies.id, x.companyId));
      await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
      expect(await events(x.approvalId)).toHaveLength(0);
    }
    const x = await seed(), other = await seed();
    await db.delete(issueApprovals).where(eq(issueApprovals.approvalId, x.approvalId));
    await db.insert(issueApprovals).values({ companyId: x.companyId, issueId: other.issueId, approvalId: x.approvalId });
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "unresolved", missingOwner: true, linkedIssueIds: [] });
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
  });
});

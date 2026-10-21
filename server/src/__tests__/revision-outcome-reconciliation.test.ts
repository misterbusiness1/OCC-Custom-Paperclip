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
  it.each([false, true])("settles cancellation after recovery, including exhausted=%s", async exhausted => {
    const x = await seed(); const enqueue = vi.fn(async () => null);
    if (exhausted) await db.update(approvals).set({ decidedAt: new Date(Date.now() - 25 * 60 * 60_000) })
      .where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, enqueue).reconcile();
    const attempts = (await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).length;
    await db.update(approvals).set({ status: "cancelled", decidedAt: new Date() }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, enqueue).reconcile();
    await revisionReconciliation(db, enqueue).reconcile();
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "disposed", blocker: null });
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(attempts);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, x.issueId));
    expect(actions.every(action => action.status === "resolved")).toBe(true);
  });
  it.each([1, 48])("does not strand a %s-hour revision behind an unrelated pending card", async hours => {
    const x = await seed(); const enqueue = vi.fn(async () => null); const unrelated = randomUUID();
    await db.update(approvals).set({ decidedAt: new Date(Date.now() - hours * 60 * 60_000) }).where(eq(approvals.id, x.approvalId));
    await db.insert(approvals).values({ id: unrelated, companyId: x.companyId, type: "request_board_approval",
      requestedByAgentId: x.agentId, status: "pending", payload: { title: "Separate spend approval" } });
    await db.insert(issueApprovals).values({ companyId: x.companyId, issueId: x.issueId, approvalId: unrelated });
    await revisionReconciliation(db, enqueue).reconcile();
    const outcome = await latest(x.approvalId);
    expect(outcome.blocker).not.toBe(`approval:${unrelated}`);
    if (hours === 1) expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(1);
    else {
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, x.issueId));
      expect(action).toMatchObject({ ownerType: "board", cause: "approval_revision_unresolved", status: "escalated" });
    }
    const [card] = await db.select().from(approvals).where(eq(approvals.id, unrelated));
    expect(card.status).toBe("pending");
  });
  it("settles its own action across multiple links while preserving an unrelated action", async () => {
    const x = await seed(), otherIssue = randomUUID(), otherAction = randomUUID(), ownAction = randomUUID();
    await db.insert(issues).values({ id: otherIssue, companyId: x.companyId, title: "Separate work", status: "todo" });
    await db.insert(issueApprovals).values({ companyId: x.companyId, issueId: otherIssue, approvalId: x.approvalId });
    const [card] = await db.select().from(approvals).where(eq(approvals.id, x.approvalId));
    const revisionKey = `${x.approvalId}:${card.decidedAt!.toISOString()}`;
    await db.insert(issueRecoveryActions).values([
      { id: otherAction, companyId: x.companyId, sourceIssueId: otherIssue, kind: "stranded_assigned_issue",
        ownerType: "board", cause: "separate_problem", fingerprint: "separate", nextAction: "Review separate work" },
      { id: ownAction, companyId: x.companyId, sourceIssueId: x.issueId, kind: "stranded_assigned_issue",
        ownerType: "board", cause: "approval_revision_unresolved", fingerprint: revisionKey,
        evidence: { approvalId: x.approvalId }, nextAction: "Review revision" },
    ]);
    await db.insert(activityLog).values({ companyId: x.companyId, actorType: "system", actorId: "revision-recovery",
      action: REVISION_OUTCOME_ACTIVITY, entityType: "approval", entityId: x.approvalId,
      details: { outcome: "unresolved", revisionDecidedAt: card.decidedAt!.toISOString(), revisionKey } });
    await db.update(approvals).set({ status: "cancelled", decidedAt: new Date() }).where(eq(approvals.id, x.approvalId));
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    const rows = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, x.companyId));
    expect(rows.find(row => row.id === ownAction)!.status).toBe("resolved");
    expect(rows.find(row => row.id === otherAction)!.status).toBe("active");
  });
  it("gives an overdue human blocker accountable attention without resolving it", async () => {
    const x = await seed(); const interactionId = randomUUID();
    await db.update(approvals).set({ decidedAt: new Date(Date.now() - 48 * 60 * 60_000) }).where(eq(approvals.id, x.approvalId));
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: x.companyId, issueId: x.issueId,
      kind: "request_confirmation", status: "pending", continuationPolicy: "wake_assignee", payload: { title: "Human decision" } });
    const enqueue = vi.fn(async () => null);
    await revisionReconciliation(db, enqueue).reconcile();
    await revisionReconciliation(db, enqueue).reconcile();
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, x.issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ ownerType: "board", cause: "approval_revision_unresolved" });
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(interaction.status).toBe("pending");
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
  it("preserves an explicit unblock descriptor on a requester-owned blocked task", async () => {
    const x = await seed();
    await db.update(issues).set({ status: "blocked", unblockDescriptor: { owner: "board", action: "Confirm the recipient contract" } })
      .where(eq(issues.id, x.issueId));
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker", blocker: `unblock_descriptor:${x.issueId}` });
  });
  it("preserves an unresolved upstream dependency even when it has no assignee", async () => {
    const x = await seed(), upstream = randomUUID();
    await db.insert(issues).values({ id: upstream, companyId: x.companyId, title: "Awaiting upstream owner", status: "todo" });
    await db.insert(issueRelations).values({ companyId: x.companyId, issueId: upstream, relatedIssueId: x.issueId, type: "blocks" });
    await revisionReconciliation(db, vi.fn(async () => null)).reconcile();
    expect(await events(x.approvalId, REVISION_ATTEMPT_ACTIVITY)).toHaveLength(0);
    expect(await latest(x.approvalId)).toMatchObject({ outcome: "durable_blocker", blocker: `issue:${upstream}` });
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

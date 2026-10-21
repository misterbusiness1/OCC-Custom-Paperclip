import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, approvals, companies, createDb, issueApprovals, issues } from "@paperclipai/db";
import { approvalQueueAttention } from "../services/approval-queue-attention.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("company-scoped approval queue diagnostics", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-approval-attention-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function company() {
    const [row] = await db.insert(companies).values({ name: "Queue test", issuePrefix: randomUUID().slice(0, 8) }).returning();
    return row!.id;
  }
  async function approval(companyId: string, extra: Partial<typeof approvals.$inferInsert> = {}) {
    const [row] = await db.insert(approvals).values({ companyId, type: "request_board_approval", payload: {}, ...extra }).returning();
    return row!;
  }
  it("uses the latest board revision, preserves real task blockers/follow-up, and does not infer completion", async () => {
    const companyId = await company();
    const [owner] = await db.insert(agents).values({ companyId, name: "Reviewer", role: "engineer", status: "paused" }).returning();
    const sentBack = await approval(companyId, { status: "revision_requested", requestedByAgentId: owner!.id, updatedAt: new Date("2026-10-21T12:00:00Z") });
    const before = new Date("2026-10-19T12:00:00Z");
    const latest = new Date("2026-10-20T12:00:00Z");
    await db.insert(activityLog).values([before, latest].map((createdAt) => ({ companyId, actorType: "user", actorId: "board", action: "approval.revision_requested", entityType: "approval", entityId: sentBack.id, createdAt })));
    const followUp = new Date("2026-10-22T12:00:00Z");
    const [task] = await db.insert(issues).values({ companyId, title: "Waiting for board", status: "blocked", assigneeAgentId: owner!.id, unblockDescriptor: { owner: "board", action: "Approve the recipient contract" }, monitorNextCheckAt: followUp }).returning();
    await db.insert(issueApprovals).values({ companyId, issueId: task!.id, approvalId: sentBack.id });
    const attention = (await approvalQueueAttention(db, companyId, [sentBack])).get(sentBack.id)!;
    expect(attention.revisionRequestedAt).toEqual(latest);
    expect(attention.owner).toMatchObject({ name: "Reviewer", status: "paused" });
    expect(attention.tasks[0]).toMatchObject({ status: "blocked", blockerAction: "Approve the recipient contract", nextFollowUpAt: followUp });
    expect(attention.staleReasons).toEqual([]);
    expect((await db.select().from(approvals)).find((row) => row.id === sentBack.id)?.status).toBe("revision_requested");
  });
  it("does not expose foreign requester, task or revision audit metadata and serializes dates", async () => {
    const companyId = await company();
    const otherId = await company();
    const [foreignAgent] = await db.insert(agents).values({ companyId: otherId, name: "Private foreign agent", role: "engineer" }).returning();
    const date = new Date("2026-10-20T12:00:00Z");
    const row = await approval(companyId, { status: "revision_requested", requestedByAgentId: foreignAgent!.id, decidedAt: date });
    const [foreignTask] = await db.insert(issues).values({ companyId: otherId, title: "Private foreign task", status: "done" }).returning();
    await db.insert(issueApprovals).values({ companyId, approvalId: row.id, issueId: foreignTask!.id });
    await db.insert(activityLog).values({ companyId: otherId, actorType: "user", actorId: "foreign-board", action: "approval.revision_requested", entityType: "approval", entityId: row.id, createdAt: new Date("2026-10-21T12:00:00Z") });
    const result = (await approvalQueueAttention(db, companyId, [row])).get(row.id)!;
    expect(result.owner).toEqual({ agentId: null, userId: null, name: null, status: null });
    expect(result.tasks).toEqual([]);
    expect(result.staleReasons).toEqual([]);
    expect(JSON.parse(JSON.stringify(result)).revisionRequestedAt).toBe(date.toISOString());
  });
  it("accepts only an exact current-revision outcome and never treats a successful run as completion", async () => {
    const companyId = await company();
    const otherId = await company();
    const date = new Date("2026-10-21T12:00:00.000Z");
    const followUp = "2026-10-22T12:00:00.000Z";
    const base = { revisionKey: "opaque-cycle-key", revisionDecidedAt: date.toISOString(),
      outcome: "durable_blocker", blocker: "Await board", requestedByAgentId: null,
      attemptCount: 1, nextFollowUpAt: followUp, nextAction: "Recheck approval", executionActive: false };
    const cases = [
      { details: base, accepted: true },
      { details: { ...base, revisionDecidedAt: "2026-10-20T12:00:00.000Z" }, accepted: false },
      { details: { ...base, revisionDecidedAt: "invalid" }, accepted: false },
      { details: { ...base, nextFollowUpAt: "not-a-date" }, accepted: false },
      { details: { ...base, revisionKey: "" }, accepted: false },
      { details: { ...base, attemptCount: -1 }, accepted: false },
      { details: { ...base, outcome: "resubmitted" }, accepted: false },
      { details: { ...base, outcome: "disposed" }, accepted: false },
      { details: { ...base, outcome: "succeeded" }, accepted: false },
      { details: base, companyId: otherId, accepted: false },
    ];
    for (const test of cases) {
      const row = await approval(companyId, { status: "revision_requested", decidedAt: date });
      await db.insert(activityLog).values({ companyId: test.companyId ?? companyId, actorType: "system", actorId: "recovery", action: "approval.revision_outcome", entityType: "approval", entityId: row.id, details: test.details });
      const result = (await approvalQueueAttention(db, companyId, [row])).get(row.id)!;
      if (test.accepted) expect(result.revisionOutcome).toMatchObject({ outcome: "durable_blocker", blocker: "Await board", nextFollowUpAt: new Date(followUp) });
      else expect(result.revisionOutcome).toBeNull();
      expect(row.status).toBe("revision_requested");
    }
    const pending = await approval(companyId, { status: "pending", decidedAt: date });
    await db.insert(activityLog).values({ companyId, actorType: "system", actorId: "recovery", action: "approval.revision_outcome", entityType: "approval", entityId: pending.id, details: base });
    expect((await approvalQueueAttention(db, companyId, [pending])).get(pending.id)?.revisionOutcome).toBeNull();
  });

  it("flags closed linked tasks for review without closing their approval", async () => {
    const companyId = await company();
    const row = await approval(companyId);
    const [task] = await db.insert(issues).values({ companyId, title: "Complete task", status: "done", monitorNextCheckAt: new Date("2020-01-01Z") }).returning();
    await db.insert(issueApprovals).values({ companyId, issueId: task!.id, approvalId: row.id });
    const result = (await approvalQueueAttention(db, companyId, [row])).get(row.id)!;
    expect(result.staleReasons).toEqual(["linked_task_closed"]);
    expect(result.owner).toMatchObject({ agentId: null, userId: null });
    expect(result.tasks[0]?.nextFollowUpAt).toBeNull();
  });
  it("accepts only an explicit distinct same-company replacement, never similar titles or foreign IDs", async () => {
    const companyId = await company();
    const foreignId = await company();
    const replacement = await approval(companyId, { payload: { title: "Same title" } });
    const foreign = await approval(foreignId);
    for (const [pointer, expected] of [[replacement.id, true], [foreign.id, false], ["not-a-uuid", false], [null, false]] as const) {
      const row = await approval(companyId, { payload: { title: "Same title", supersededByApprovalId: pointer } });
      const result = (await approvalQueueAttention(db, companyId, [row])).get(row.id)!;
      expect(result.staleReasons.includes("explicitly_superseded")).toBe(expected);
      expect(result.supersededByApprovalId).toBe(expected ? replacement.id : null);
    }
    const self = { ...replacement, payload: { supersededByApprovalId: replacement.id } };
    expect((await approvalQueueAttention(db, companyId, [self])).get(self.id)?.supersededByApprovalId).toBeNull();
  });
});

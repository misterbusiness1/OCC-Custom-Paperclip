import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, approvals, companies, createDb, heartbeatRuns, issueApprovals, issues } from "@paperclipai/db";
import { deliverCurrentApprovalDecision } from "../services/approval-decision-delivery.js";
import { isVerifiedApprovalDecisionWakeForConversation, isVerifiedApprovalDecisionWakeForRequester } from "../services/approval-decision-wake.js";
import { revokeApproval } from "../services/approval-revocation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("post-commit approval decision delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-decision-delivery-lock-");
    // A guard borrowing this single-connection pool would deadlock its callback.
    db = createDb(temp.connectionString, { maxConnections: 1 });
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function seed(status = "approved", type = "request_board_approval") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Decision delivery", issuePrefix: `D${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Requester", status: "idle", adapterType: "process" }).returning();
    const [approval] = await db.insert(approvals).values({ companyId, type, status, requestedByAgentId: agent!.id,
      payload: {}, decidedAt: new Date(), updatedAt: new Date() }).returning();
    return { approval: approval!, agent: agent!, companyId };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const revoke = (database: typeof db, f: Fixture) => revokeApproval(database, {
    companyId: f.companyId, approvalId: f.approval.id, userId: "board", decisionNote: "Withdraw",
    expectedUpdatedAt: f.approval.updatedAt,
  });
  async function enqueueBoth(f: Fixture) {
    for (const kind of ["requester", "review_path"]) {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
        source: "automation", status: "queued", payload: { approvalId: f.approval.id, approvalStatus: "approved", kind } }).returning();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "queued",
        wakeupRequestId: wake!.id, contextSnapshot: { approvalId: f.approval.id, approvalStatus: "approved", kind } });
    }
  }

  it("suppresses late requester and review-path delivery when revocation wins", async () => {
    const f = await seed();
    const revoker = createDb(temp.connectionString, { maxConnections: 1, applicationName: "late-delivery-revoker" });
    const observer = createDb(temp.connectionString, { maxConnections: 1 });
    let signal!: () => void, unlock!: () => void;
    const locked = new Promise<void>((resolve) => { signal = resolve; });
    const released = new Promise<void>((resolve) => { unlock = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(approvals).where(eq(approvals.id, f.approval.id)).for("update");
      signal(); await released;
    });
    await locked;
    const revocation = revoke(revoker, f);
    const deliver = vi.fn(() => enqueueBoth(f));
    let delivery!: ReturnType<typeof deliverCurrentApprovalDecision>;
    try {
      // Queue the real revoker first, then the late decision delivery behind it.
      await vi.waitFor(async () => {
        const waiting = await observer.execute(sql`select pid from pg_stat_activity
          where application_name = 'late-delivery-revoker' and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5_000 });
      delivery = deliverCurrentApprovalDecision(db, f.approval, deliver);
      await vi.waitFor(async () => {
        const waiting = await observer.execute(sql`select pid from pg_stat_activity
          where application_name = 'paperclip-workspace-finalization-lock' and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5_000 });
    } finally { unlock(); }
    await holder;
    expect((await revocation).status).toBe("cancelled");
    expect(await delivery).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await isVerifiedApprovalDecisionWakeForRequester(db, { companyId: f.companyId, agentId: f.agent.id,
      contextSnapshot: { approvalId: f.approval.id, wakeReason: "approval_approved", approvalStatus: "approved" } })).toBe(false);
  });

  it("makes revocation wait for admitted delivery and see all its queued wakes and runs", async () => {
    const f = await seed();
    let signal!: () => void, unlock!: () => void;
    const admitted = new Promise<void>((resolve) => { signal = resolve; });
    const released = new Promise<void>((resolve) => { unlock = resolve; });
    const delivery = deliverCurrentApprovalDecision(db, f.approval, async () => {
      await enqueueBoth(f);
      signal();
      await released;
      return "delivered";
    });
    await admitted;
    const revoker = createDb(temp.connectionString, { maxConnections: 1, applicationName: "decision-delivery-revoker" });
    const revocation = revoke(revoker, f);
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity
          where application_name = 'decision-delivery-revoker' and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5_000 });
    } finally { unlock(); }
    expect(await delivery).toBe("delivered");
    expect((await revocation).status).toBe("cancelled");
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(wakes).toHaveLength(2);
    expect(runs).toHaveLength(2);
    expect(wakes.every((row) => row.status === "cancelled")).toBe(true);
    expect(runs.every((row) => row.status === "cancelled")).toBe(true);
  });

  it("releases the approval lock and dedicated connection when delivery throws", async () => {
    const f = await seed();
    await expect(deliverCurrentApprovalDecision(db, f.approval, async () => { throw new Error("admission failed"); }))
      .rejects.toThrow("admission failed");
    expect((await revoke(db, f)).status).toBe("cancelled");
    const clients = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
      and application_name = 'paperclip-workspace-finalization-lock'`);
    expect(clients.length).toBe(0);
  });

  it("rejects a stale version even when the decision status is unchanged", async () => {
    const f = await seed();
    await db.update(approvals).set({ updatedAt: new Date(f.approval.updatedAt.getTime() + 1) }).where(eq(approvals.id, f.approval.id));
    const deliver = vi.fn();
    expect(await deliverCurrentApprovalDecision(db, f.approval, deliver)).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
    expect(await isVerifiedApprovalDecisionWakeForRequester(db, { companyId: f.companyId, agentId: f.agent.id,
      contextSnapshot: { approvalId: f.approval.id, wakeReason: "approval_approved", approvalStatus: "approved",
        approvalUpdatedAt: f.approval.updatedAt.toISOString() } })).toBe(false);
  });

  it.each(["approved", "rejected", "revision_requested"])("preserves %s decision delivery and requester verification", async (status) => {
    const f = await seed(status);
    expect(await deliverCurrentApprovalDecision(db, f.approval, async () => "delivered")).toBe("delivered");
    expect(await isVerifiedApprovalDecisionWakeForRequester(db, { companyId: f.companyId, agentId: f.agent.id,
      contextSnapshot: { approvalId: f.approval.id, wakeReason: `approval_${status}`, approvalStatus: status,
        approvalUpdatedAt: f.approval.updatedAt.toISOString() } })).toBe(true);
  });

  it("rejects malformed or contradictory decision context before granting the requester exception", async () => {
    const f = await seed();
    const context = { approvalId: f.approval.id, wakeReason: "approval_approved", approvalStatus: "approved" };
    for (const overrides of [{ approvalStatus: "rejected" }, { approvalUpdatedAt: 123 },
      { approvalUpdatedAt: "not-a-date" }, { approvalUpdatedAt: "1" }]) {
      expect(await isVerifiedApprovalDecisionWakeForRequester(db, { companyId: f.companyId, agentId: f.agent.id,
        contextSnapshot: { ...context, ...overrides } })).toBe(false);
    }
  });

  it("rejects an old conversation decision after the approval moves to a newer version of the same status", async () => {
    const f = await seed();
    await db.update(approvals).set({ decidedByUserId: "board" }).where(eq(approvals.id, f.approval.id));
    const [conversation] = await db.insert(issues).values({ companyId: f.companyId, title: "Conversation", status: "todo",
      assigneeAgentId: f.agent.id, conversationAgentId: f.agent.id, conversationUserId: "board", conversationState: "waiting" }).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: conversation!.id, approvalId: f.approval.id });
    const input = { companyId: f.companyId, agentId: f.agent.id, issueId: conversation!.id,
      requestedByActorType: "user", requestedByActorId: "board",
      contextSnapshot: { approvalId: f.approval.id, wakeReason: "approval_approved", approvalStatus: "approved",
        approvalUpdatedAt: f.approval.updatedAt.toISOString() } };
    expect(await isVerifiedApprovalDecisionWakeForConversation(db, input)).toBe(true);
    const newVersion = new Date(f.approval.updatedAt.getTime() + 1);
    await db.update(approvals).set({ updatedAt: newVersion }).where(eq(approvals.id, f.approval.id));
    expect(await isVerifiedApprovalDecisionWakeForConversation(db, input)).toBe(false);
    expect(await isVerifiedApprovalDecisionWakeForConversation(db,
      { ...input, contextSnapshot: { ...input.contextSnapshot, approvalUpdatedAt: newVersion.toISOString() } })).toBe(true);
  });

  it("preserves hire decision delivery without making hire revocable", async () => {
    const f = await seed("approved", "hire_agent");
    expect(await deliverCurrentApprovalDecision(db, f.approval, async () => "hire-result")).toBe("hire-result");
    await expect(revoke(db, f)).rejects.toMatchObject({ status: 422 });
  });
});

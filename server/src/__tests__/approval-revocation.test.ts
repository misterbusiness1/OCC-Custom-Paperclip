import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, approvals, companies, createDb, heartbeatRuns,
  toolActionRequests, toolInvocations } from "@paperclipai/db";
import { revokeApproval } from "../services/approval-revocation.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("approved request revocation", () => {
  let db!: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-revocation-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });
  async function seed(status = "approved") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Revocation", issuePrefix: `V${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Requester", status: "idle", adapterType: "process" }).returning();
    const [approval] = await db.insert(approvals).values({ companyId, type: "request_board_approval", status,
      requestedByAgentId: agent!.id, payload: { title: "Website copy" }, decidedAt: new Date(), updatedAt: new Date() }).returning();
    return { companyId, agent: agent!, approval: approval! };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  function app(companyId: string, agentId?: string) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = agentId ? { type: "agent", agentId, companyId } : {
        type: "board", source: "session", userId: "board", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false,
      }; next();
    }); app.use("/api", approvalRoutes(db)); app.use(errorHandler); return app;
  }
  const body = (f: Fixture) => ({ expectedUpdatedAt: f.approval.updatedAt.toISOString(), decisionNote: "Withdraw superseded copy" });
  const revoke = (f: Fixture) => request(app(f.companyId)).post(`/api/approvals/${f.approval.id}/revoke`).send(body(f));
  async function action(f: Fixture, status: "pending" | "approved" | "executing" | "executed") {
    const [invocation] = await db.insert(toolInvocations).values({ companyId: f.companyId, toolName: "test.write",
      status: status === "executed" ? "succeeded" : status === "executing" ? "executing" : "awaiting_approval" }).returning();
    const [row] = await db.insert(toolActionRequests).values({ companyId: f.companyId, invocationId: invocation!.id,
      approvalId: f.approval.id, status, canonicalArgumentsHash: "test", canonicalArgumentsSummary: {} as any }).returning();
    return row!;
  }
  it("withdraws approval and cancels only its unstarted tool actions and decision wake", async () => {
    const f = await seed(); const pending = await action(f, "approved"); const other = await seed(); const untouched = await action(other, "approved");
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id, source: "automation",
      status: "queued", payload: { approvalId: f.approval.id, approvalStatus: "approved" } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "queued",
      contextSnapshot: { approvalId: f.approval.id, approvalStatus: "approved" } }).returning();
    const result = await revoke(f); expect(result.status).toBe(200); expect(result.body.status).toBe("cancelled");
    expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0]!.status).toBe("cancelled");
    expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, untouched.id)))[0]!.status).toBe("approved");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!.status).toBe("cancelled");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)))[0]!.status).toBe("cancelled");
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, f.approval.id))).map(x => x.action)).toEqual(["approval.revoked"]);
    // A late claimant can no longer consume the old approved action.
    expect(await db.update(toolActionRequests).set({ status: "executing" }).where(and(eq(toolActionRequests.id, pending.id), eq(toolActionRequests.status, "approved"))).returning()).not.toContainEqual(expect.objectContaining({ id: pending.id }));
  });
  it.each(["executing", "executed"] as const)("refuses to claim safe revocation for %s actions", async status => {
    const f = await seed(); await action(f, status);
    const result = await revoke(f); expect(result.status).toBe(409); expect(result.body.code ?? result.body.details?.code).toBe("approval_execution_started");
    expect((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status).toBe("approved");
  });
  it.each(["agent", "foreign-company", "empty-reason", "stale-version"])("rejects %s revocation", async kind => {
    const f = await seed(), other = await seed();
    const application = app(kind === "foreign-company" ? other.companyId : f.companyId, kind === "agent" ? f.agent.id : undefined);
    const input = { ...body(f), ...(kind === "empty-reason" ? { decisionNote: " " } : {}),
      ...(kind === "stale-version" ? { expectedUpdatedAt: new Date(0).toISOString() } : {}) };
    const response = await request(application).post(`/api/approvals/${f.approval.id}/revoke`).send(input).timeout({ deadline: 8000 });
    expect(response.status).toBe(kind === "agent" ? 403 : kind === "foreign-company" ? 404 : kind === "empty-reason" ? 400 : 409);
  });
  it.each(["failed", "timed_out", "rate_limited"] as const)("preserves uncertain %s execution history", async status => {
    const f = await seed(); const pending = await action(f, "approved");
    await db.update(toolActionRequests).set({ status: "failed" }).where(eq(toolActionRequests.id, pending.id));
    await db.update(toolInvocations).set({ status, startedAt: new Date(Date.now() - 60_000) })
      .where(eq(toolInvocations.id, pending.invocationId));
    expect((await revoke(f)).status).toBe(409);
    expect((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status).toBe("approved");
  });
  it.each([
    { sendStatus: "draft", executionStatus: "completed" },
    { sendStatus: "sent", executionStatus: "pending" },
  ])("preserves completed payload evidence independently: %j", async payload => {
    const f = await seed();
    await db.update(approvals).set({ payload }).where(eq(approvals.id, f.approval.id));
    expect((await revoke(f)).status).toBe(409);
    expect((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status).toBe("approved");
  });
  it("refuses a claimed decision wake before reporting safe revocation", async () => {
    const f = await seed(); await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "automation", status: "claimed", claimedAt: new Date(), payload: { approvalId: f.approval.id } });
    expect((await revoke(f)).status).toBe(409);
  });
  it.each(["completed", "failed", "cancelled"])("preserves terminal %s wake evidence", async status => {
    const f = await seed();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "automation", status, claimedAt: new Date(), finishedAt: new Date(),
      payload: { approvalId: f.approval.id } }).returning();
    expect((await revoke(f)).status).toBe(409);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)))[0]!.status).toBe(status);
    expect((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status).toBe("approved");
  });
  it.each(["succeeded", "failed", "cancelled"])("preserves terminal %s run evidence", async status => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status, startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { approvalId: f.approval.id } }).returning();
    expect((await revoke(f)).status).toBe(409);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!.status).toBe(status);
    expect((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status).toBe("approved");
  });
  it.each(["failed", "cancelled"])("rejects uncertain %s history without start timestamps", async status => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status, contextSnapshot: { approvalId: f.approval.id } });
    expect((await revoke(f)).status).toBe(409);
  });
  it("rejects a run finishing while revocation waits for its lock", async () => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "running", startedAt: new Date(), contextSnapshot: { approvalId: f.approval.id } }).returning();
    const revoker = createDb(temp.connectionString, { maxConnections: 1, applicationName: "revocation-terminal-race" });
    let signal!: () => void, unlock!: () => void;
    const locked = new Promise<void>(r => { signal = r; });
    const released = new Promise<void>(r => { unlock = r; });
    const finish = db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).for("update");
      signal(); await released;
      await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    });
    await locked;
    const attempt = revokeApproval(revoker, { companyId: f.companyId, approvalId: f.approval.id,
      userId: "board", decisionNote: "Withdraw", expectedUpdatedAt: f.approval.updatedAt })
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where application_name = 'revocation-terminal-race' and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5000 });
    } finally { unlock(); }
    await finish;
    expect((await attempt).error).toMatchObject({ status: 409 });
    expect((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status).toBe("approved");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!.status).toBe("succeeded");
  });
  it("follows dispatcher wake-before-run lock order without deadlock", async () => {
    const f = await seed();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "automation", status: "queued", payload: { approvalId: f.approval.id } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "queued",
      wakeupRequestId: wake!.id, contextSnapshot: { approvalId: f.approval.id } }).returning();
    const revoker = createDb(temp.connectionString, { maxConnections: 1, applicationName: "revocation-dispatch-race" });
    let signal!: () => void, unlock!: () => void; const locked = new Promise<void>(r => { signal = r; });
    const released = new Promise<void>(r => { unlock = r; });
    const claim = db.transaction(async tx => {
      await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id)).for("update");
      signal(); await released;
      await tx.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
      await tx.update(agentWakeupRequests).set({ status: "claimed", claimedAt: new Date() }).where(eq(agentWakeupRequests.id, wake!.id));
    });
    await locked;
    const attempt = revokeApproval(revoker, { companyId: f.companyId, approvalId: f.approval.id, userId: "board",
      decisionNote: "Withdraw", expectedUpdatedAt: f.approval.updatedAt }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where application_name = 'revocation-dispatch-race' and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5000 });
    } finally { unlock(); }
    await claim; expect((await attempt).error).toMatchObject({ status: 409 });
  });
  it("matches native settlement invocation-before-request locks without deadlock", async () => {
    const f = await seed(); const pending = await action(f, "executing");
    const revoker = createDb(temp.connectionString, { maxConnections: 1, applicationName: "revocation-settlement-race" });
    let signal!: () => void, unlock!: () => void;
    const locked = new Promise<void>(r => { signal = r; });
    const released = new Promise<void>(r => { unlock = r; });
    const settlement = db.transaction(async tx => {
      await tx.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)).for("update");
      signal(); await released;
      await tx.update(toolActionRequests).set({ status: "executed" }).where(eq(toolActionRequests.id, pending.id));
      await tx.update(toolInvocations).set({ status: "succeeded", completedAt: new Date() })
        .where(eq(toolInvocations.id, pending.invocationId));
    });
    await locked;
    const attempt = revokeApproval(revoker, { companyId: f.companyId, approvalId: f.approval.id, userId: "board",
      decisionNote: "Withdraw", expectedUpdatedAt: f.approval.updatedAt })
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where application_name = 'revocation-settlement-race' and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5000 });
    } finally { unlock(); }
    await settlement;
    expect((await attempt).error).toMatchObject({ status: 409 });
    expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0]!.status).toBe("executed");
  });
  it("does not partially cancel pending work when another action has started", async () => {
    const f = await seed(); const pending = await action(f, "approved"); await action(f, "executing");
    expect((await revoke(f)).status).toBe(409);
    expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0]!.status).toBe("approved");
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.approval.id))).toHaveLength(0);
  });
  it("a tool claim that wins the lock prevents a false safe-revocation acknowledgement", async () => {
    const f = await seed(); const pending = await action(f, "approved");
    const revoker = createDb(temp.connectionString, { maxConnections: 1, applicationName: "revocation-race" });
    let unlock!: () => void, signal!: () => void;
    const released = new Promise<void>(r => { unlock = r; }); const locked = new Promise<void>(r => { signal = r; });
    const claim = db.transaction(async tx => {
      await tx.update(toolActionRequests).set({ status: "executing" }).where(eq(toolActionRequests.id, pending.id));
      signal(); await released;
    });
    await locked;
    const revokeResult = revokeApproval(revoker, { companyId: f.companyId, approvalId: f.approval.id,
      userId: "board", decisionNote: "Withdraw", expectedUpdatedAt: f.approval.updatedAt })
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where application_name = 'revocation-race' and wait_event_type = 'Lock'`);
        expect(waiting.length).toBe(1);
      }, { timeout: 5000 });
    } finally { unlock(); }
    await claim; expect((await revokeResult).error).toMatchObject({ status: 409 });
    expect((await db.select().from(approvals).where(eq(approvals.id, f.approval.id)))[0]!.status).toBe("approved");
  });
  it("rejects a second concurrent revocation without duplicate audit", async () => {
    const f = await seed(); const results = await Promise.all([revoke(f), revoke(f)]);
    expect(results.map(x => x.status).sort()).toEqual([200, 409]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.approval.id))).toHaveLength(1);
  });
  it("refuses revocation while its decision run is active", async () => {
    const f = await seed(); await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
      status: "running", startedAt: new Date(), contextSnapshot: { approvalId: f.approval.id } });
    expect((await revoke(f)).status).toBe(409);
  });
  it("does not revoke a pending request or reverse a hire/budget side effect", async () => {
    const f = await seed("pending"); expect((await revoke(f)).status).toBe(422);
    await db.update(approvals).set({ status: "approved", type: "hire_agent" }).where(eq(approvals.id, f.approval.id));
    expect((await revoke(f)).status).toBe(422);
  });
});

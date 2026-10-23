import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, agentWakeupRequests, issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
if (!support.supported) console.warn(`Reservation seam tests unavailable: ${support.reason}`);

suite("PATCH reassignment / heartbeat reservation seam", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("reassignment-reservation-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    // Fence late fire-and-forget route wakes before draining this disposable DB.
    await db.update(agents).set({ status: "paused" });
    for (const run of await db.select().from(heartbeatRuns)) {
      if (["queued", "running"].includes(run.status)) {
        await heartbeat.cancelRun(run.id, "Disposable seam fixture cleanup", { suppressImmediateRecovery: true });
      }
    }
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  function app(companyId: string) {
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit", userId: "local-board",
        companyIds: [companyId], isInstanceAdmin: true };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use(errorHandler);
    return client;
  }

  async function seed(status = "queued") {
    const companyId = randomUUID(), oldOwner = randomUUID(), newOwner = randomUUID();
    const issueId = randomUUID(), sourceRun = randomUUID(), activeRun = randomUUID();
    const otherQueued = randomUUID(), wakeId = randomUUID();
    const activeIssue = randomUUID(), queuedIssue = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Reservation test", issuePrefix: "RSV",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "local-board" });
    await db.insert(agents).values([oldOwner, newOwner].map((id) => ({ id, companyId,
      name: id === oldOwner ? "Former owner" : "New owner", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} })));
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId: oldOwner,
      source: "assignment", reason: "issue_assigned", status: "queued", payload: { issueId } });
    await db.insert(heartbeatRuns).values([
      { id: sourceRun, companyId, agentId: oldOwner, status, wakeupRequestId: wakeId,
        invocationSource: "assignment", contextSnapshot: { issueId, taskId: issueId },
        ...(status === "running" ? { startedAt: new Date() } : {}) },
      { id: activeRun, companyId, agentId: oldOwner, status: "running", startedAt: new Date(),
        invocationSource: "automation", contextSnapshot: { issueId: activeIssue } },
      { id: otherQueued, companyId, agentId: oldOwner, status: "queued",
        invocationSource: "automation", contextSnapshot: { issueId: queuedIssue } },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Queued former owner",
      status: "todo", priority: "high", assigneeAgentId: oldOwner, executionRunId: sourceRun,
      executionAgentNameKey: "former-owner", executionLockedAt: new Date(), issueNumber: 1, identifier: "RSV-1" });
    await db.insert(issues).values([
      { id: activeIssue, companyId, title: "Unrelated active issue", status: "in_progress",
        assigneeAgentId: oldOwner, executionRunId: activeRun, issueNumber: 2, identifier: "RSV-2" },
      { id: queuedIssue, companyId, title: "Unrelated queued issue", status: "todo",
        assigneeAgentId: oldOwner, executionRunId: otherQueued, issueNumber: 3, identifier: "RSV-3" },
    ]);
    return { companyId, oldOwner, newOwner, issueId, sourceRun, activeRun, otherQueued, wakeId };
  }
  const run = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(r => r[0]);

  it.each(["queued", "running"])("releases only the %s source through native cancellation and starts the new owner once", async status => {
    const s = await seed(status);
    const activeBefore = await run(s.activeRun), queuedBefore = await run(s.otherQueued);
    await request(app(s.companyId)).patch(`/api/issues/${s.issueId}`).send({ assigneeAgentId: s.newOwner }).expect(200);
    await vi.waitFor(async () => { expect((await run(s.sourceRun)).status).toBe("cancelled"); });
    expect(await run(s.sourceRun)).toMatchObject({ errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true }, ...(status === "queued" ? { startedAt: null } : {}) });
    expect(await run(s.activeRun)).toEqual(activeBefore);
    expect(await run(s.otherQueued)).toEqual(queuedBefore);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, s.wakeId)))[0].status).toBe("cancelled");
    await vi.waitFor(async () => {
      const next = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, s.newOwner),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${s.issueId}`));
      expect(next).toHaveLength(1);
      expect(next[0].startedAt).not.toBeNull();
      expect(next[0].status).toBe("running");
    }, { timeout: 10_000 });
    await request(app(s.companyId)).patch(`/api/issues/${s.issueId}`).send({ assigneeAgentId: s.newOwner }).expect(200);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.newOwner))).toHaveLength(1);
  });
  it.each(["cancelled", "succeeded", "failed"])("leaves a terminal %s reservation unchanged", async status => {
    const s = await seed(status);
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, s.issueId));
    const before = await run(s.sourceRun);
    await request(app(s.companyId)).patch(`/api/issues/${s.issueId}`).send({ assigneeAgentId: s.newOwner }).expect(200);
    expect(await run(s.sourceRun)).toEqual(before);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]).toMatchObject({
      assigneeAgentId: s.newOwner, executionRunId: null });
  });

  it.each(["agent", "company", "context", "missing-context", "missing-run"])("does not cancel a stale %s binding", async mismatch => {
    const s = await seed();
    await db.update(issues).set({ status: "backlog", ...(mismatch === "missing-run" ? { executionRunId: null } : {}) })
      .where(eq(issues.id, s.issueId));
    if (mismatch === "agent") await db.update(heartbeatRuns).set({ agentId: s.newOwner }).where(eq(heartbeatRuns.id, s.sourceRun));
    if (mismatch === "company") {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Other company", issuePrefix: "OTH" });
      await db.update(heartbeatRuns).set({ companyId }).where(eq(heartbeatRuns.id, s.sourceRun));
    }
    if (mismatch === "context" || mismatch === "missing-context") {
      await db.update(heartbeatRuns).set({ contextSnapshot: mismatch === "context" ? { issueId: randomUUID() } : {} })
        .where(eq(heartbeatRuns.id, s.sourceRun));
    }
    const before = await run(s.sourceRun), active = await run(s.activeRun), queued = await run(s.otherQueued);
    await request(app(s.companyId)).patch(`/api/issues/${s.issueId}`).send({ assigneeAgentId: s.newOwner }).expect(200);
    expect(await run(s.sourceRun)).toEqual(before);
    expect(await run(s.activeRun)).toEqual(active);
    expect(await run(s.otherQueued)).toEqual(queued);
  });

  it("coalesces concurrent assignments to the same new owner without duplicate starts", async () => {
    const s = await seed();
    const client = app(s.companyId);
    const results = await Promise.all([1, 2].map(() => request(client).patch(`/api/issues/${s.issueId}`)
      .send({ assigneeAgentId: s.newOwner })));
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect((await run(s.sourceRun)).status).toBe("cancelled");
    await vi.waitFor(async () => {
      const next = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.newOwner));
      expect(next).toHaveLength(1);
      expect(next[0].startedAt).not.toBeNull();
      const wakes = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, s.newOwner), eq(agentWakeupRequests.reason, "issue_assigned")));
      expect(wakes).toHaveLength(1);
    }, { timeout: 10_000 });
  });

});

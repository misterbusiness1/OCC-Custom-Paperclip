import { boardCommentRequestProtocolRoutes } from "../routes/board-comment-request-protocol.js";
import { heartbeatService } from "../services/heartbeat.js";
import { boardCommentRequestDelivery } from "../services/board-comment-request-delivery.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, heartbeatRuns, agentWakeupRequests, companies, createDb, issues, issueComments, issueCommentRequests, issueCommentRequestEffects,
  closeRegisteredClients, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import type { StorageService } from "../storage/types.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe.sequential : describe.skip;
suite("actual HTTP durable Board comment admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const oldAdmission = process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-comment-http-");
    db = createDb(database.connectionString, { maxConnections: 8 });
    process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED = "true";
    app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as StorageService)); app.use("/api", boardCommentRequestProtocolRoutes(db)); app.use(errorHandler);
  }, 30_000);
  afterAll(async () => {
    if (oldAdmission === undefined) delete process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED;
    else process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED = oldAdmission;
    await closeRegisteredClients(database.connectionString); await database.cleanup();
  });
  async function seed(status = "todo") {
    const companyId = randomUUID(); const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "HTTP fixture", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Board request", status });
    return { companyId, issueId, clientRequestId: randomUUID(), body: "Approved original request" };
  }
  it("admits simultaneous first HTTP submissions once and returns the existing 201 comment shape", async () => {
    const input = await seed("done");
    const body = { body: input.body, clientRequestId: input.clientRequestId, reopen: true };
    let unlock!: () => void; let locked!: () => void;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, input.issueId)).for("update"); locked(); await release;
    });
    await lockReady;
    const first = request(app).post(`/api/issues/${input.issueId}/comments`).send(body).then(response => response);
    const second = request(app).post(`/api/issues/${input.issueId}/comments`).send(body).then(response => response);
    await new Promise(resolve => setTimeout(resolve, 100)); unlock(); await holder;
    const responses = await Promise.all([first, second]);
    for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(responses[0].body).toMatchObject({ body: input.body, authorUserId: "local-board", clientRequestId: input.clientRequestId });
    expect(responses[0].body).not.toHaveProperty("request");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId))).toHaveLength(1);
    const rows = await db.select().from(issueCommentRequests).where(eq(issueCommentRequests.issueId, input.issueId));
    expect(rows).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, input.issueId)))[0].status).toBe("todo");
    expect((await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, rows[0].id))).length).toBeGreaterThan(0);
  });
  it("rejects same-body changed intent without mutating the accepted request", async () => {
    const input = await seed(); const endpoint = `/api/issues/${input.issueId}/comments`;
    const first = await request(app).post(endpoint).send(input); expect(first.status, JSON.stringify(first.body)).toBe(201);
    const conflict = await request(app).post(endpoint).send({ ...input, interrupt: true });
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId))).toHaveLength(1);
  });
  it("replays historical comments without inventing delivery intent and rejects changed content", async () => {
    const input = await seed("done");
    const [saved] = await db.insert(issueComments).values({ companyId: input.companyId, issueId: input.issueId,
      authorType: "user", authorUserId: "local-board", body: input.body, clientRequestId: input.clientRequestId }).returning();
    const endpoint = `/api/issues/${input.issueId}/comments`;
    const results = await Promise.all([request(app).post(endpoint).send({ ...input, interrupt: true, reopen: true }),
      request(app).post(endpoint).send({ ...input, interrupt: true, reopen: true })]);
    for (const result of results) { expect(result.status, JSON.stringify(result.body)).toBe(201); expect(result.body.id).toBe(saved.id); }
    expect(await db.select().from(issueCommentRequests).where(eq(issueCommentRequests.issueId, input.issueId))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, input.issueId)))[0].status).toBe("done");
    const changed = await request(app).post(endpoint).send({ ...input, body: "Changed historical request", interrupt: true });
    expect(changed.status).toBe(409);
  });
  it("returns 410 for a deleted accepted comment and never restores its intent", async () => {
    const input = await seed(); const endpoint = `/api/issues/${input.issueId}/comments`;
    const first = await request(app).post(endpoint).send(input); expect(first.status).toBe(201);
    await db.update(issueComments).set({ deletedAt: new Date(), body: "[deleted]", updatedAt: new Date() }).where(eq(issueComments.id, first.body.id));
    const replay = await request(app).post(endpoint).send(input); expect(replay.status).toBe(410);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId))).toHaveLength(1);
  });
  it("executes the first preparing-run interruption and durable successor wake with original actor and intent", async () => {
    const input = await seed("in_progress"); const agentId = randomUUID(); const runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: input.companyId, name: "Preparing agent", adapterType: "process",
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId, status: "queued",
      executionStage: "preparing", contextSnapshot: { issueId: input.issueId }, runtimeMode: "legacy" });
    await db.update(issues).set({ assigneeAgentId: agentId, executionRunId: runId }).where(eq(issues.id, input.issueId));
    const heartbeat = heartbeatService(db); heartbeat.startTaskDrain();
    const oldDispatch = process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED;
    process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED = "false";
    try {
      const response = await request(app).post(`/api/issues/${input.issueId}/comments`).send({ ...input, interrupt: true });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const [accepted] = await db.select().from(issueCommentRequests).where(eq(issueCommentRequests.issueId, input.issueId));
      expect(accepted.canonicalEnvelope).toMatchObject({ interrupt: true, authorUserId: "local-board" });
      process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED = "true";
      await boardCommentRequestDelivery(db, heartbeat).dispatchRequest(input.companyId, accepted.id);
      const effects = await db.select().from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.requestId, accepted.id));
      expect(effects.every(effect => effect.status === "delivered"), JSON.stringify(effects)).toBe(true);
      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.resultJson?.boardCommentCancellation).toMatchObject({ requestId: accepted.id,
        authorUserId: "local-board", targetRunId: runId, commentId: response.body.id });
      const wakeEffect = effects.find(effect => effect.kind === "wake")!;
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, wakeEffect.idempotencyKey));
      expect(wake).toMatchObject({ requestedByActorId: "local-board", payload: { commentId: response.body.id, interruptedRunId: runId } });
      const replay = await request(app).post(`/api/issues/${input.issueId}/comments`).send({ ...input, interrupt: true });
      expect(replay.status).toBe(201); expect(replay.body.id).toBe(response.body.id);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, wakeEffect.idempotencyKey))).toHaveLength(1);
    } finally {
      heartbeat.stopTaskDrain();
      if (oldDispatch === undefined) delete process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED;
      else process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED = oldDispatch;
    }
  });
  it("recovers committed HTTP intent after dispatcher recreation and exposes safe operational state", async () => {
    const input = await seed(); const oldDispatch = process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED;
    process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED = "false";
    const heartbeat = heartbeatService(db); heartbeat.startTaskDrain();
    try {
      const accepted = await request(app).post(`/api/issues/${input.issueId}/comments`).send(input);
      expect(accepted.status).toBe(201);
      const pending = await request(app).get(`/api/issues/${input.issueId}/comment-requests/${input.clientRequestId}`);
      expect(pending.status, JSON.stringify(pending.body)).toBe(200); expect(pending.body.status).toBe("pending");
      expect(pending.body.effects.length).toBeGreaterThan(0);
      expect(pending.body.effects[0]).not.toHaveProperty("descriptor");
      const operational = await request(app).get("/api/board-comment-request-protocol");
      expect(operational.status, JSON.stringify(operational.body)).toBe(200);
      expect(operational.body.queue.pendingCount).toBeGreaterThan(0);
      expect(operational.body.queue.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
      process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED = "true";
      await boardCommentRequestDelivery(db, heartbeatService(db)).recover();
      const settled = await request(app).get(`/api/issues/${input.issueId}/comment-requests/${input.clientRequestId}`);
      expect(settled.body.status, JSON.stringify(settled.body)).toBe("delivered");
      expect(settled.body.commentId).toBe(accepted.body.id);
    } finally {
      heartbeat.stopTaskDrain();
      if (oldDispatch === undefined) delete process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED;
      else process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED = oldDispatch;
    }
  });
  it("fails closed while admission is paused without legacy mutation", async () => {
    const input = await seed(); process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED = "false";
    try {
      const result = await request(app).post(`/api/issues/${input.issueId}/comments`).send(input);
      expect(result.status, JSON.stringify(result.body)).toBe(503);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId))).toHaveLength(0);
    } finally { process.env.PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED = "true"; }
  });
});

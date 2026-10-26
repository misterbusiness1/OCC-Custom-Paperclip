import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings, companies, agents, issues, heartbeatRuns } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { deploymentLeaseService, type DeploymentLeasePermit } from "../services/deployment-lease.js";

describe("durable deployment lease ownership and recovery", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const boot = randomUUID();
  const service = () => deploymentLeaseService(db, { bootId: boot });
  const acquire = (generation = 0, takeOverExpired = false) => service().acquire({
    expectedBootId: boot, expectedLeaseGeneration: generation, ttlMs: 60_000, takeOverExpired,
  });
  const permit = (lease: { generation: number; ownerToken: string }, bootId = boot): DeploymentLeasePermit => ({
    expectedBootId: bootId, expectedLeaseGeneration: lease.generation, ownerToken: lease.ownerToken,
  });
  async function expire() {
    const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "deployment-drain/v1"));
    await db.update(instanceSettings).set({ general: { ...row.general, expiresAt: "2000-01-01T00:00:00.000Z" } })
      .where(eq(instanceSettings.id, row.id));
  }
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("deployment-lease-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterEach(async () => { await db.delete(instanceSettings).where(eq(instanceSettings.singletonKey, "deployment-drain/v1")); });
  afterAll(async () => { await temp.cleanup(); });

  it("exposes only public status, and stores a hash rather than the capability", async () => {
    expect(await service().get()).toMatchObject({ owned: false, draining: false, generation: 0 });
    const lease = await acquire();
    expect(lease.ownerToken).toMatch(/^[a-f0-9]{64}$/);
    const status = await service().get();
    expect(status).toMatchObject({ owned: true, expired: false, generation: 1, ownerBootId: boot });
    expect(JSON.stringify(status)).not.toContain(lease.ownerToken);
    const rows = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "deployment-drain/v1"));
    expect(JSON.stringify(rows)).not.toContain(lease.ownerToken);
  });
  it("serializes concurrent acquisition across independent service instances", async () => {
    const outcomes = await Promise.allSettled([acquire(), acquire()]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(x => x.status === "rejected")).toHaveLength(1);
    expect((await service().get()).generation).toBe(1);
  });
  it("rejects wrong owner, stale generation and stale server boot before effects", async () => {
    const lease = await acquire(); let effects = 0;
    for (const bad of [
      { ...permit(lease), ownerToken: "0".repeat(64) },
      { ...permit(lease), expectedLeaseGeneration: 0 },
      { ...permit(lease), expectedBootId: randomUUID() },
    ]) await expect(service().withOwner(bad, () => { effects++; })).rejects.toMatchObject({ status: 409 });
    expect(effects).toBe(0);
  });
  it("retains the hold and rejects all tokenless legacy changes after expiry", async () => {
    const lease = await acquire();
    await service().transitionDrain(permit(lease), true, async () => undefined);
    await expire();
    expect(await service().get()).toMatchObject({ owned: true, expired: true, draining: true });
    await expect(service().transitionDrain(undefined, false, async () => undefined)).rejects.toMatchObject({ status: 409 });
    await expect(service().transitionDrain(undefined, true, async () => undefined)).rejects.toMatchObject({ status: 409 });
    expect((await service().get()).draining).toBe(true);
  });
  it("requires explicit generation-CAS takeover and preserves an expired drain", async () => {
    const first = await acquire();
    const drain = await service().transitionDrain(permit(first), true, async () => undefined);
    await expire();
    await expect(acquire(drain.lease!.generation)).rejects.toMatchObject({ status: 409 });
    const successor = await acquire(drain.lease!.generation, true);
    expect(successor).toMatchObject({ draining: true, generation: 3, expired: false });
    expect(successor.ownerToken).not.toBe(first.ownerToken);
    await expect(service().transitionDrain({ ...permit(first), expectedLeaseGeneration: 3 }, false, async () => undefined))
      .rejects.toMatchObject({ status: 409 });
  });
  it("retains the drain across a new process boot and requires owner adoption", async () => {
    const first = await acquire();
    const drain = await service().transitionDrain(permit(first), true, async () => undefined);
    const newBoot = randomUUID(); const next = deploymentLeaseService(db, { bootId: newBoot });
    expect(await next.get()).toMatchObject({ bootId: newBoot, ownerBootId: boot, draining: true });
    const previous = { ...permit(first, newBoot), expectedLeaseGeneration: drain.lease!.generation };
    await expect(next.withOwner(previous, () => undefined)).rejects.toMatchObject({ status: 409 });
    await expect(next.adopt({ ...previous, expectedOwnerBootId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    const adopted = await next.adopt({ ...previous, expectedOwnerBootId: boot });
    expect(adopted).toMatchObject({ generation: 3, ownerBootId: newBoot, draining: true });
    await expect(next.withOwner({ ...previous, expectedLeaseGeneration: adopted.generation }, () => "owned"))
      .resolves.toBe("owned");
  });
  it("does not release ownership while its durable drain is active", async () => {
    const lease = await acquire();
    const drain = await service().transitionDrain(permit(lease), true, async () => undefined);
    await expect(service().release({ ...permit(lease), expectedLeaseGeneration: drain.lease!.generation }))
      .rejects.toMatchObject({ status: 409 });
    const stopped = await service().transitionDrain({ ...permit(lease), expectedLeaseGeneration: drain.lease!.generation }, false, async () => undefined);
    const released = await service().release({ ...permit(lease), expectedLeaseGeneration: stopped.lease!.generation });
    expect(released).toMatchObject({ owned: false, generation: 4, draining: false });
    await expect(service().withOwner(permit(lease), () => undefined)).rejects.toMatchObject({ status: 409 });
  });
  it("rolls ownership and drain state back when atomic audit persistence fails", async () => {
    await expect(service().acquire({ expectedBootId: boot, expectedLeaseGeneration: 0, ttlMs: 1000 },
      async () => { throw new Error("fixture audit unavailable"); })).rejects.toThrow("fixture audit unavailable");
    expect(await service().get()).toMatchObject({ owned: false, generation: 0 });
    const lease = await acquire();
    await expect(service().transitionDrain(permit(lease), true, async () => { throw new Error("fixture audit unavailable"); }))
      .rejects.toThrow("fixture audit unavailable");
    expect(await service().get()).toMatchObject({ owned: true, draining: false, generation: 1 });
  });
  it("requires successful atomic audit before an owner-protected release effect", async () => {
    const lease = await acquire();
    const drain = await service().transitionDrain(permit(lease), true, async () => undefined);
    const owner = { ...permit(lease), expectedLeaseGeneration: drain.lease!.generation };
    let released = false;
    await expect(service().withOwner(owner, () => { released = true; }, { requireDraining: true,
      audit: async () => { throw new Error("fixture audit unavailable"); } })).rejects.toThrow("fixture audit unavailable");
    expect(released).toBe(false);
    expect(await service().get()).toMatchObject({ generation: 2, draining: true });
    let auditFinished = false;
    await service().withOwner(owner, () => { expect(auditFinished).toBe(true); released = true; }, {
      requireDraining: true, audit: async (_tx, _event, status) => {
        expect(JSON.stringify(status)).not.toContain(lease.ownerToken); auditFinished = true;
      },
    });
    expect(released).toBe(true);
  });
  it("serializes owner effects against a concurrent takeover", async () => {
    const lease = await acquire(); let started!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    // transitionDrain holds the exact row through audit and state commit.
    const first = service().transitionDrain(permit(lease), true, async () => { started(); await gate; });
    await entered;
    const second = acquire(1, true);
    release(); await first;
    await expect(second).rejects.toMatchObject({ status: 409 });
    expect(await service().get()).toMatchObject({ generation: 2, draining: true });
  });
  it("renews with a new generation and rejects an expired owner", async () => {
    const lease = await acquire();
    const renewed = await service().renew({ ...permit(lease), ttlMs: 120_000 });
    expect(renewed.generation).toBe(2);
    await expect(service().withOwner(permit(lease), () => undefined)).rejects.toMatchObject({ status: 409 });
    await expire();
    await expect(service().withOwner({ ...permit(lease), expectedLeaseGeneration: 2 }, () => undefined)).rejects.toMatchObject({ status: 409 });
    expect((await service().get()).owned).toBe(true);
  });
  it("fails closed for malformed persisted ownership state", async () => {
    await db.insert(instanceSettings).values({ singletonKey: "deployment-drain/v1", general: { v: 1 } });
    await expect(service().get()).rejects.toMatchObject({ status: 503 });
    await expect(acquire()).rejects.toMatchObject({ status: 503 });
  });
  it("enforces ownership and admin authority through the actual HTTP drain controls", async () => {
    const [{ default: express }, { default: request }, { deploymentLeaseRoutes }, { instanceSettingsRoutes }, { errorHandler }] = await Promise.all([
      import("express"), import("supertest"), import("../routes/deployment-lease.js"),
      import("../routes/instance-settings.js"), import("../middleware/error-handler.js"),
    ]);
    const server = (admin: boolean) => {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", userId: "fixture-operator", source: "session", isInstanceAdmin: admin }; next(); });
      app.use("/api", deploymentLeaseRoutes(db)); app.use("/api", instanceSettingsRoutes(db)); app.use(errorHandler);
      return app;
    };
    const denied = await request(server(false)).post("/api/instance/deployment-lease").send({});
    expect(denied.status).toBe(403); expect((await service().get()).owned).toBe(false);
    const app = server(true); const initial = await request(app).get("/api/instance/deployment-lease");
    const acquired = await request(app).post("/api/instance/deployment-lease").send({
      expectedBootId: initial.body.bootId, expectedLeaseGeneration: 0, ttlMs: 60_000,
    });
    expect(acquired.status).toBe(200);
    const cap = acquired.body.ownerToken;
    const ownedPermit = { ownerToken: cap, expectedLeaseGeneration: 1, expectedBootId: initial.body.bootId };
    expect(JSON.stringify((await request(app).get("/api/instance/deployment-lease")).body)).not.toContain(cap);
    const drain = await request(app).post("/api/instance/task-drain").send({ deploymentLease: ownedPermit });
    expect(drain.status).toBe(200); expect(drain.body.deploymentLease.generation).toBe(2); expect(drain.body.expiresAt).toBeNull();
    expect((await request(app).delete("/api/instance/task-drain")).status).toBe(409);
    expect((await request(app).post("/api/instance/task-drain").send({})).status).toBe(409);
    const stopped = await request(app).delete("/api/instance/task-drain").send({ deploymentLease: { ...ownedPermit, expectedLeaseGeneration: 2 } });
    expect(stopped.status).toBe(200); expect(stopped.body.deploymentLease.generation).toBe(3);
    const released = await request(app).delete("/api/instance/deployment-lease").send({ ...ownedPermit, expectedLeaseGeneration: 3 });
    expect(released.status).toBe(200); expect(released.body.owned).toBe(false);
  }, 30_000);
  it("guards a real held-startup release by the durable owner and retains its drain", async () => {
    const [{ default: express }, { default: request }, { startupWorkBarrierRoutes, startupWorkBarrierHttpGate },
      { createStartupWorkBarrier }, { errorHandler }, { configuredBoardCommentRequestControls }] = await Promise.all([
      import("express"), import("supertest"), import("../routes/startup-work-barrier.js"),
      import("../services/startup-work-barrier.js"), import("../middleware/error-handler.js"),
      import("../services/board-comment-request-operational.js"),
    ]);
    const barrier = createStartupWorkBarrier({ PAPERCLIP_STARTUP_WORK_HELD: "true" });
    const heldBoot = barrier.snapshot().bootId; const leases = deploymentLeaseService(db, { bootId: heldBoot });
    const acquired = await leases.acquire({ expectedBootId: heldBoot, expectedLeaseGeneration: 0, ttlMs: 60_000 });
    const cap = { ownerToken: acquired.ownerToken, expectedLeaseGeneration: 1, expectedBootId: heldBoot };
    const app = express(); app.use(express.json()); app.use(startupWorkBarrierHttpGate(barrier));
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "fixture-operator", source: "session", isInstanceAdmin: true }; next(); });
    app.use("/api", startupWorkBarrierRoutes(db, { barrier, qualifyDatabase: async () => {} })); app.use(errorHandler);
    const body = { expectedBootId: heldBoot, expectedGeneration: 0, qualificationSha256: "b".repeat(64),
      expectedProtocolVersion: 1, expectedConfiguredControls: configuredBoardCommentRequestControls(), deploymentLease: cap };
    expect((await request(app).post("/api/startup-work-barrier/release").send(body)).status).toBe(409);
    expect(barrier.isHeld()).toBe(true); // Ownership alone cannot bypass the independent drain.
    const drain = await leases.transitionDrain(cap, true, async () => undefined);
    expect((await request(app).post("/api/startup-work-barrier/release").send(body)).status).toBe(409);
    const result = await request(app).post("/api/startup-work-barrier/release").send({ ...body,
      deploymentLease: { ...cap, expectedLeaseGeneration: drain.lease!.generation } });
    expect(result.status).toBe(200); expect(result.body.startupWork.held).toBe(false);
    expect(await leases.isDraining()).toBe(true); // Release does not silently reopen run admission.
  }, 30_000);
  it("keeps real queued work held across process-cache reset until its durable owner clears it", async () => {
    const { heartbeatService, stopTaskDrain } = await import("../services/heartbeat.js");
    const companyId = randomUUID(); const agentId = randomUUID(); const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deployment lease fixture", issuePrefix: "DLF", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lease fixture agent", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic lease-held work", status: "todo", priority: "low",
      assigneeAgentId: agentId, responsibleUserId: "fixture-user" });
    const first = await acquire();
    const owned = await service().transitionDrain(permit(first), true, async () => undefined);
    const heartbeat = heartbeatService(db);
    try {
      await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        requestedByActorType: "system", requestedByActorId: "lease_fixture" });
      stopTaskDrain(); // An old process cache reset must not clear durable ownership.
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      const held = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(held).toHaveLength(1); expect(held[0].status).toBe("queued");
      expect(await service().isDraining()).toBe(true);
      await service().transitionDrain({ ...permit(first), expectedLeaseGeneration: owned.lease!.generation }, false, async () => undefined);
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      const finished = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(finished[0].status).toBe("succeeded");
    } finally { stopTaskDrain(); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
});

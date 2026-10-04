import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { startupWorkBarrierHttpGate, startupWorkBarrierRoutes } from "../routes/startup-work-barrier.js";
import { createStartupWorkBarrier } from "../services/startup-work-barrier.js";
import { resetStartupRecoveryStateForTests, setStartupRecoveryPhase } from "../startup-recovery-state.js";
import { errorHandler } from "../middleware/error-handler.js";

const held = () => createStartupWorkBarrier({ PAPERCLIP_STARTUP_WORK_HELD: "true" });
const permit = (barrier: ReturnType<typeof held>) => ({ expectedBootId: barrier.snapshot().bootId,
  expectedGeneration: 0, qualificationSha256: "a".repeat(64), expectedProtocolVersion: 1,
  expectedConfiguredControls: { admission: false, dispatch: false } });
function app(barrier: ReturnType<typeof held>, qualifyDatabase = vi.fn(async () => {}), admin = true) {
  const server = express(); server.use(express.json()); server.use(startupWorkBarrierHttpGate(barrier));
  server.use((req, _res, next) => { req.actor = { type: "board", userId: "operator", source: "session", isInstanceAdmin: admin }; next(); });
  server.use("/api", startupWorkBarrierRoutes({} as Db, { barrier, qualifyDatabase }));
  server.all("/{*path}", (_req, res) => res.json({ reached: true })); server.use(errorHandler);
  return server;
}
afterEach(() => { resetStartupRecoveryStateForTests(); vi.unstubAllEnvs(); });
describe("startup work release authorization and ordering", () => {
  it.each(["/api/issues", "/api/agents/x/wakeup", "/api/chat/webhook", "/mcp", "/api/companies/x/health"])("blocks business route %s before handlers", async path => {
    const response = await request(app(held())).get(path);
    expect(response.status).toBe(503); expect(response.body.code).toBe("startup_work_held");
  });
  it("keeps health/auth available and denies operator controls to non-admin before database qualification", async () => {
    const barrier = held(); const qualify = vi.fn(async () => {}); const server = app(barrier, qualify, false);
    expect((await request(server).get("/api/health")).status).toBe(200);
    expect((await request(server).post("/api/auth/sign-in")).status).toBe(200);
    expect((await request(server).get("/api/startup-work-barrier")).status).toBe(403);
    expect((await request(server).post("/api/startup-work-barrier/release").send(permit(barrier))).status).toBe(403);
    expect(qualify).not.toHaveBeenCalled(); expect(barrier.isHeld()).toBe(true);
  });
  it("does not release if database qualification fails", async () => {
    const barrier = held(); const response = await request(app(barrier, async () => { throw new Error("fixture database mismatch"); }))
      .post("/api/startup-work-barrier/release").send(permit(barrier));
    expect(response.status).toBe(500); expect(barrier.isHeld()).toBe(true);
  });
  it("rejects incomplete bootstrap, stale boot, changed controls and repeat release", async () => {
    const barrier = held(); const server = app(barrier);
    setStartupRecoveryPhase("recovering");
    expect((await request(server).post("/api/startup-work-barrier/release").send(permit(barrier))).status).toBe(503);
    resetStartupRecoveryStateForTests();
    expect((await request(server).post("/api/startup-work-barrier/release").send({ ...permit(barrier), expectedBootId: held().snapshot().bootId })).status).toBe(409);
    expect((await request(server).post("/api/startup-work-barrier/release").send({ ...permit(barrier), expectedConfiguredControls: { admission: true, dispatch: false } })).status).toBe(409);
    expect(barrier.isHeld()).toBe(true);
    expect((await request(server).post("/api/startup-work-barrier/release").send(permit(barrier))).status).toBe(200);
    expect((await request(server).get("/api/issues")).status).toBe(200);
    expect((await request(server).post("/api/startup-work-barrier/release").send(permit(barrier))).status).toBe(409);
  });
  it("qualifies before release and accepts only one concurrent permit", async () => {
    const barrier = held(); let release!: () => void; let entered = 0;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const server = app(barrier, async () => { entered++; await ready; });
    const first = request(server).post("/api/startup-work-barrier/release").send(permit(barrier)).then(x => x);
    const second = request(server).post("/api/startup-work-barrier/release").send(permit(barrier)).then(x => x);
    await vi.waitFor(() => expect(entered).toBe(2)); expect(barrier.isHeld()).toBe(true);
    release(); const results = await Promise.all([first, second]);
    expect(results.map(x => x.status).sort()).toEqual([200, 409]); expect(barrier.snapshot().generation).toBe(1);
  });
});

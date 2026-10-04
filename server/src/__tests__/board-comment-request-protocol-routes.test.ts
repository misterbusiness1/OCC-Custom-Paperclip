import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardCommentRequestProtocolRoutes } from "../routes/board-comment-request-protocol.js";
import { boardCommentRequestOperationalSnapshot, trackBoardCommentRequestOperation } from "../services/board-comment-request-operational.js";

function app(actor: express.Request["actor"]) {
  const server = express();
  server.use((req, _res, next) => { req.actor = actor; next(); });
  server.use("/api", boardCommentRequestProtocolRoutes());
  server.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return server;
}

describe("Board comment protocol operational evidence", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([{ type: "none" }, { type: "agent", agentId: "agent" }, { type: "board", userId: "non-admin", source: "session" }])("rejects non-admin readers: %j", async (actor) => {
    const response = await request(app(actor as express.Request["actor"])).get("/api/board-comment-request-protocol");
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty("protocolVersion");
  });
  it("exposes source-defined capability, exact effective switches, and process identity only", async () => {
    vi.stubEnv("PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED", "true");
    vi.stubEnv("PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED", "1");
    const response = await request(app({ type: "board", userId: "admin", source: "session", isInstanceAdmin: true })).get("/api/board-comment-request-protocol");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ protocolVersion: 1, processBootId: expect.any(String),
      controls: { admission: true, dispatch: false }, inFlight: { admission: 0, dispatch: 0 } });
  });
  it("counts an outstanding operation and releases its count when it throws", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const operation = trackBoardCommentRequestOperation("admission", async () => { await held; throw new Error("fixture failure"); });
    const assertion = expect(operation).rejects.toThrow("fixture failure");
    expect(boardCommentRequestOperationalSnapshot().inFlight).toEqual({ admission: 1, dispatch: 0 });
    release(); await assertion;
    expect(boardCommentRequestOperationalSnapshot().inFlight).toEqual({ admission: 0, dispatch: 0 });
  });
});

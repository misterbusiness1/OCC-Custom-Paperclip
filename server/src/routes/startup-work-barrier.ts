import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertInstanceAdmin } from "./authz.js";
import { HttpError } from "../errors.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";
import { startupWorkBarrier, StartupWorkBarrierError } from "../services/startup-work-barrier.js";
import { configuredBoardCommentRequestControls, boardCommentRequestOperationalSnapshot } from "../services/board-comment-request-operational.js";
import { assertCommentRequestRollbackSafe, BOARD_COMMENT_REQUEST_PROTOCOL_VERSION } from "../services/issue-comment-requests.js";

/** GET is not generally safe: business read routes can perform reconciliation. */
export function startupWorkBarrierHttpGate(barrier = startupWorkBarrier): RequestHandler {
  return (req, res, next) => {
    if (!barrier.isHeld()) { next(); return; }
    const path = req.path;
    if (path === "/api/auth" || path.startsWith("/api/auth/")
      || (req.method === "GET" && ["/api/health", "/api/startup-work-barrier", "/api/board-comment-request-protocol"].includes(path))
      || (req.method === "POST" && path === "/api/startup-work-barrier/release")) {
      next(); return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ error: "Startup work is held", code: "startup_work_held" });
  };
}
const releaseSchema = z.object({
  expectedBootId: z.string().uuid(), expectedGeneration: z.number().int().nonnegative(),
  qualificationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedProtocolVersion: z.number().int().nonnegative(),
  expectedConfiguredControls: z.object({ admission: z.boolean(), dispatch: z.boolean() }).strict(),
}).strict();

export function startupWorkBarrierRoutes(db: Db, options: {
  barrier?: typeof startupWorkBarrier;
  /** Test seam only. Production checks real schema and retained compatibility. */
  qualifyDatabase?: () => Promise<void>;
} = {}) {
  const barrier = options.barrier ?? startupWorkBarrier;
  const router = Router();
  const qualifyDatabase = options.qualifyDatabase ?? (async () => {
    const rows = await db.execute(sql`select to_regclass('public.issue_comment_requests') is not null
      and to_regclass('public.issue_comment_request_effects') is not null as ready`);
    if (rows.length !== 1 || rows[0]?.ready !== true) throw new HttpError(503, "Board comment protocol schema is not ready");
    await assertCommentRequestRollbackSafe(db, BOARD_COMMENT_REQUEST_PROTOCOL_VERSION);
  });
  const snapshot = () => ({ startupWork: barrier.snapshot(), startupRecovery: getStartupRecoveryState(),
    protocol: boardCommentRequestOperationalSnapshot() });
  router.get("/startup-work-barrier", async (req, res) => {
    assertInstanceAdmin(req);
    res.setHeader("Cache-Control", "no-store");
    await qualifyDatabase();
    res.json(snapshot());
  });
  router.post("/startup-work-barrier/release", async (req, res) => {
    assertInstanceAdmin(req);
    res.setHeader("Cache-Control", "no-store");
    const input = releaseSchema.parse(req.body);
    const observed = barrier.snapshot();
    if (!observed.held || observed.bootId !== input.expectedBootId || observed.generation !== input.expectedGeneration) {
      throw new HttpError(409, "Startup work release permit is stale");
    }
    if (getStartupRecoveryState().phase !== "ready") throw new HttpError(503, "Server bootstrap is not ready");
    await qualifyDatabase();
    // Checks follow the final await; two permits cannot both release this boot.
    const configured = configuredBoardCommentRequestControls();
    if (input.expectedProtocolVersion !== BOARD_COMMENT_REQUEST_PROTOCOL_VERSION
      || input.expectedConfiguredControls.admission !== configured.admission
      || input.expectedConfiguredControls.dispatch !== configured.dispatch) {
      throw new HttpError(409, "Qualified protocol controls changed");
    }
    const inFlight = boardCommentRequestOperationalSnapshot().inFlight;
    if (inFlight.admission !== 0 || inFlight.dispatch !== 0) throw new HttpError(409, "Protocol operations remain in flight");
    try { barrier.release(input); }
    catch (error) {
      if (error instanceof StartupWorkBarrierError) throw new HttpError(409, error.code);
      throw error;
    }
    res.json(snapshot());
  });
  return router;
}

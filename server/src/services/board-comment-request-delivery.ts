import { logger } from "../middleware/logger.js";
import { and, asc, eq, ne } from "drizzle-orm";
import { issueCommentRequestEffects, type Db } from "@paperclipai/db";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { heartbeatService } from "./heartbeat.js";
import { issueCommentRequestService, boardCommentRequestControls } from "./issue-comment-requests.js";
import { authorizeBoardCommentRequest } from "./board-comment-request-authority.js";
import { boardCommentRequestRuntimeEffects } from "./board-comment-request-runtime-effects.js";
import { createBoardCommentProjectionHandlers, createBoardCommentActivityPublicationHandler,
  createBoardCommentExternalObjectsHandler } from "./board-comment-request-effect-handlers.js";
import { createBoardCommentSourceRecoveryHandler, createBoardCommentWatchdogHandler } from "./board-comment-request-recovery-effects.js";
import { createBoardCommentSteerHandler } from "./board-comment-request-steer-effect.js";
import { createBoardCommentWorkspaceCleanupHandler, createBoardCommentSandboxCleanupHandler } from "./board-comment-request-environment-effects.js";

import { createBoardCommentWorkspaceReopenHandler, recoverOrphanedBoardCommentWorkspaceReservations } from "./board-comment-request-workspace-reopen.js";

type Heartbeat = Pick<ReturnType<typeof heartbeatService>, "cancelRun" | "wakeup" | "waitForRunExecutionDrain">;
const recovering = new WeakMap<Db, Promise<{ scanned: number; attempts: number }>>();

/** Bind the closed protocol to production services; no arbitrary effect callbacks. */
export function boardCommentRequestDelivery(db: Db, heartbeat: Heartbeat, pluginWorkerManager?: PluginWorkerManager) {
  const service = issueCommentRequestService(db, {
    authorize: authorizeBoardCommentRequest,
    handlers: {
      ...createBoardCommentProjectionHandlers(), ...boardCommentRequestRuntimeEffects(db, heartbeat),
      external_objects: createBoardCommentExternalObjectsHandler(db, pluginWorkerManager),
      activity_publication: createBoardCommentActivityPublicationHandler(db),
      source_recovery_revalidation: createBoardCommentSourceRecoveryHandler(),
      watchdog: createBoardCommentWatchdogHandler(db, { enqueueWakeup: heartbeat.wakeup }),
      steer: createBoardCommentSteerHandler(db),
      workspace_cleanup: createBoardCommentWorkspaceCleanupHandler(), sandbox_cleanup: createBoardCommentSandboxCleanupHandler(),
      workspace_reopen: createBoardCommentWorkspaceReopenHandler(db),
    },
  });
  async function dispatchRequest(companyId: string, requestId: string, limit = 24) {
    let attempts = 0;
    while (attempts < Math.min(32, Math.max(1, limit)) && boardCommentRequestControls().dispatch) {
      const [before] = await db.select({ id: issueCommentRequestEffects.id, status: issueCommentRequestEffects.status,
        generation: issueCommentRequestEffects.generation }).from(issueCommentRequestEffects).where(and(
        eq(issueCommentRequestEffects.requestId, requestId), eq(issueCommentRequestEffects.companyId, companyId),
        ne(issueCommentRequestEffects.status, "delivered"),
      )).orderBy(asc(issueCommentRequestEffects.ordinal)).limit(1);
      if (!before) break;
      await service.dispatchOne(companyId, requestId); attempts++;
      const [after] = await db.select({ status: issueCommentRequestEffects.status, generation: issueCommentRequestEffects.generation })
        .from(issueCommentRequestEffects).where(eq(issueCommentRequestEffects.id, before.id));
      // A held/ambiguous predecessor needs a later recovery pass. Cleanup may
      // still have advanced internally, but never spin on a blocked operation.
      if (!after || after.status !== "delivered") break;
    }
    return attempts;
  }
  function recover() {
    if (!boardCommentRequestControls().dispatch) return Promise.resolve({ scanned: 0, attempts: 0 });
    const active = recovering.get(db); if (active) return active;
    const run = (async () => {
      await recoverOrphanedBoardCommentWorkspaceReservations(db, 50);
      const pending = await service.pending(50); let attempts = 0; let scanned = 0;
      for (const entry of pending) {
        if (attempts >= 64 || !boardCommentRequestControls().dispatch) break;
        try {
          attempts += await dispatchRequest(entry.companyId, entry.id, Math.min(8, 64 - attempts));
        } catch (error) {
          attempts++;
          logger.warn({ event: "board_comment_request.recovery_failed", requestId: entry.id,
            companyId: entry.companyId, err: error }, "Board comment delivery recovery failed");
        }
        scanned++;
      }
      return { scanned, attempts };
    })().finally(() => { recovering.delete(db); });
    recovering.set(db, run); return run;
  }
  return { dispatchRequest, recover };
}

import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { isCancelledLegacyPrelaunch, isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

export type BoardCommentNativeStopProof = "startup_never_dispatched" | "native_local_process_stopped" | "native_remote_termination";

function absent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || Math.abs(pid) <= 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Read physical stop evidence for one captured run. The caller must hold its
 * run/controller locks through completion; a cancellation acknowledgement and
 * an empty process-local execution map are not provider-stop evidence. This
 * does not prove that a particular Board request caused the stop. */
export async function boardCommentNativeStopProof(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  coordinator: typeof nativeRunFinalizations.$inferSelect | undefined,
): Promise<BoardCommentNativeStopProof | null> {
  if (!run.finishedAt || !["cancelled", "succeeded", "failed", "timed_out"].includes(run.status)) return null;
  if (coordinator && (coordinator.companyId !== run.companyId || coordinator.runId !== run.id
    || coordinator.issueId !== run.nativeIssueId)) return null;
  if (await isCancelledLegacyPrelaunch(db, run, coordinator) || await isCancelledNativeStartup(db, run, coordinator)) {
    return "startup_never_dispatched";
  }
  if (run.runtimeMode !== "native" || !coordinator || coordinator.leaseOwner || coordinator.leaseExpiresAt
    || !["applied", "terminal_failure"].includes(coordinator.phase)) return null;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  // Never interpret a provider's PID in the control-plane host namespace.
  if (leases.some(lease => lease.provider !== "local")) {
    return leases.length > 0 && leases.every(hasRemoteTerminationReceipt) ? "native_remote_termination" : null;
  }
  if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return null;
  if (run.processPid || run.processGroupId) {
    // Both identities matter: a leader may exit while descendants remain.
    if ((run.processPid && !absent(run.processPid)) || (run.processGroupId && !absent(-run.processGroupId))) return null;
    return "native_local_process_stopped";
  }
  return await hasNativeLocalProcessStop(db, run.companyId, run.id) ? "native_local_process_stopped" : null;
}

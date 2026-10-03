import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { claimedAdapterType, isConversationAdapter } from "./conversation-continuation.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

/** Caller holds the coordinator and run locks when using this proof to admit
 * work. Attempt zero is a durable never-claimed receipt: every native executor
 * commits its first claim before it can start or attach a provider. */
export async function isCancelledNativeStartup(db: Db, run: Run, coordinator: Coordinator | undefined) {
  if (run.status !== "cancelled" || !run.finishedAt || run.processPid || run.processGroupId ||
      run.processStartedAt || run.sessionIdAfter) return false;
  const cancellation = run.resultJson?.startupCancellation as Record<string, unknown> | undefined;
  const beforeSelection = run.runtimeMode === "legacy" && !run.runtimeModeResolvedAt &&
    !run.nativeSessionId && !coordinator && claimedAdapterType(run) === "paperclip_runner" &&
    cancellation?.beforeNativeSelection === true;
  const neverClaimed = run.runtimeMode === "native" && coordinator &&
    ["observed", "terminal_failure"].includes(coordinator.phase) && coordinator.attempt === 0 &&
    coordinator.controllerGeneration === 0 && !coordinator.controllerBootId &&
    !coordinator.controllerPid && !coordinator.leaseOwner && !coordinator.leaseExpiresAt &&
    !coordinator.resultId && !coordinator.failureDetail?.successorRunId;
  if (!beforeSelection && !neverClaimed) return false;
  const settled = typeof run.resultJson?.startupPreparationSettledAt === "string";
  // The old preparer can still be unwinding even though the run is terminal.
  if (!settled && run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if ((!settled && leases.length === 0) || leases.some(lease =>
    lease.provider === "local"
      ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
      : !hasRemoteTerminationReceipt(lease))) return false;
  // Reject contradictory retained evidence, including a crash after a launch
  // request but before the PID callback. Provider events never certify a stop.
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}

/** Proves a cancelled legacy conversation adapter never crossed dispatch. */
export async function isCancelledLegacyPrelaunch(db: Db, run: Run, coordinator: Coordinator | undefined) {
  if (coordinator || run.status !== "cancelled" || run.runtimeMode !== "legacy" ||
      run.executionStage !== "preparing" || !run.finishedAt || run.processPid ||
      run.processGroupId || run.processStartedAt || run.nativeSessionId || run.sessionIdAfter) return false;
  const receipt = run.resultJson?.legacyPrelaunchCancellation as Record<string, unknown> | undefined;
  const expectedKeys = ["adapterType", "beforeAdapterDispatch", "controllerBootId", "kind",
    "requestedAt", "settledAt", "settledControllerBootId", "version"].sort().join(",");
  if (!receipt || Object.keys(receipt).sort().join(",") !== expectedKeys) return false;
  const adapterType = claimedAdapterType(run);
  const requestedAt = typeof receipt.requestedAt === "string"
    ? Date.parse(receipt.requestedAt) : Number.NaN;
  const settledAt = typeof receipt.settledAt === "string"
    ? Date.parse(receipt.settledAt) : Number.NaN;
  const finishedAt = run.finishedAt.getTime();
  if (receipt.version !== 1 || receipt.kind !== "legacy_prelaunch_cancellation" ||
      receipt.beforeAdapterDispatch !== true || typeof receipt.requestedAt !== "string" ||
      typeof receipt.settledAt !== "string" || !adapterType || !isConversationAdapter(adapterType) ||
      receipt.adapterType !== adapterType || typeof receipt.controllerBootId !== "string" ||
      receipt.controllerBootId !== run.controllerBootId ||
      receipt.settledControllerBootId !== receipt.controllerBootId ||
      !Number.isFinite(requestedAt) || !Number.isFinite(settledAt) ||
      requestedAt > finishedAt || finishedAt > settledAt) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" ||
      lease.cleanupStatus === "failed" || (lease.provider !== "local" && !hasRemoteTerminationReceipt(lease)))) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "adapter.invoke", "harness.ready", "session.started", "session.resumed", "session.updated",
        "turn.started", "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}

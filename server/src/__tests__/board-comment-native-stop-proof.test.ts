import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { boardCommentNativeStopProof } from "../services/board-comment-native-stop-proof.js";
import { recordNativeLocalProcessStop, PROCESS_START_REQUESTED } from "../services/native-local-process-stop.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("Board native stop proof", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let exitedPid: number;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("board-native-stop-");
    db = createDb(fixture.connectionString, { maxConnections: 1 });
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
    exitedPid = child.pid!;
    await once(child, "exit");
  }, 60_000);
  afterAll(async () => {
    if (fixture) { await closeRegisteredClients(fixture.connectionString); await fixture.cleanup(); }
  });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop proof", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native fixture" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Captured task" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "cancelled", finishedAt: new Date(), resultJson: {
        nativeCancellation: { dispatchState: "acknowledged", dispatched: true },
      } }).returning();
    const [coordinator] = await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: run!.id,
      phase: "terminal_failure", attempt: 1 }).returning();
    return { run: run!, coordinator: coordinator! };
  }
  async function stoppedLocal() {
    const f = await seed();
    const [run] = await db.update(heartbeatRuns).set({ processPid: exitedPid, processGroupId: exitedPid })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    return { ...f, run: run! };
  }
  it("does not accept acknowledgement with no physical evidence", async () => {
    const f = await seed();
    expect(await boardCommentNativeStopProof(db, f.run, f.coordinator)).toBeNull();
  });
  it("accepts an exited local process and rejects a live PID", async () => {
    const f = await stoppedLocal();
    expect(await boardCommentNativeStopProof(db, f.run, f.coordinator)).toBe("native_local_process_stopped");
    expect(await boardCommentNativeStopProof(db, { ...f.run, processPid: process.pid }, f.coordinator)).toBeNull();
  });
  it("requires settled exact coordinator ownership", async () => {
    const f = await stoppedLocal();
    for (const coordinator of [undefined, { ...f.coordinator, leaseOwner: "still-running" },
      { ...f.coordinator, leaseExpiresAt: new Date(0) }, { ...f.coordinator, phase: "executing" },
      { ...f.coordinator, companyId: randomUUID() }, { ...f.coordinator, runId: randomUUID() }]) {
      expect(await boardCommentNativeStopProof(db, f.run, coordinator)).toBeNull();
    }
  });
  it("uses durable stop evidence after identity clearing but rejects a later launch", async () => {
    const f = await stoppedLocal();
    expect(await recordNativeLocalProcessStop(db, f.run)).toBe(true);
    const cleared = { ...f.run, processPid: null, processGroupId: null };
    expect(await boardCommentNativeStopProof(db, cleared, f.coordinator)).toBe("native_local_process_stopped");
    await appendHeartbeatRunEvent(db, { companyId: f.run.companyId, runId: f.run.id, agentId: f.run.agentId,
      eventType: PROCESS_START_REQUESTED, stream: "system", level: "info", message: "New launch requested" });
    expect(await boardCommentNativeStopProof(db, cleared, f.coordinator)).toBeNull();
  });
  async function addLease(f: Awaited<ReturnType<typeof seed>>, provider: string) {
    const environmentId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox", config: {} });
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.run.companyId,
      environmentId, heartbeatRunId: f.run.id, provider, providerLeaseId: randomUUID(), status: "released",
      releasedAt: new Date(), cleanupStatus: "success" }).returning();
    return lease!;
  }
  it("rejects failed or pending local cleanup even when the process exited", async () => {
    const f = await stoppedLocal();
    const lease = await addLease(f, "local");
    await db.update(environmentLeases).set({ status: "pending_cleanup" }).where(eq(environmentLeases.id, lease.id));
    expect(await boardCommentNativeStopProof(db, f.run, f.coordinator)).toBeNull();
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "failed" }).where(eq(environmentLeases.id, lease.id));
    expect(await boardCommentNativeStopProof(db, f.run, f.coordinator)).toBeNull();
  });
  it("requires every exact remote lease receipt without interpreting provider PIDs locally", async () => {
    const f = await stoppedLocal();
    const lease = await addLease(f, "remote-fixture");
    expect(await boardCommentNativeStopProof(db, f.run, f.coordinator)).toBeNull();
    const receipt = remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: receipt } }).where(eq(environmentLeases.id, lease.id));
    expect(await boardCommentNativeStopProof(db, { ...f.run, processPid: process.pid }, f.coordinator)).toBe("native_remote_termination");
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: { ...receipt, runId: randomUUID() } } }).where(eq(environmentLeases.id, lease.id));
    expect(await boardCommentNativeStopProof(db, f.run, f.coordinator)).toBeNull();
  });
  it("accepts a settled never-claimed startup but rejects contradictory launch evidence", async () => {
    const f = await seed();
    const run = { ...f.run, resultJson: { startupPreparationSettledAt: new Date().toISOString() } };
    const coordinator = { ...f.coordinator, attempt: 0 };
    expect(await boardCommentNativeStopProof(db, run, coordinator)).toBe("startup_never_dispatched");
    await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: PROCESS_START_REQUESTED, stream: "system", level: "info", message: "Contradictory launch" });
    expect(await boardCommentNativeStopProof(db, run, coordinator)).toBeNull();
  });
});

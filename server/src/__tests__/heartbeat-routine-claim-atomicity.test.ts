import { coordinateHeartbeatSchedulerShutdown } from "../shutdown.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { releaseRunClaimedJustBeforeSuppression } from "../services/heartbeat-queued-claim-release.js";
import { heartbeatService, stopTaskDrain } from "../services/heartbeat.js";
import { publishLiveEvent } from "../services/live-events.js";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })),
}));
vi.mock("../services/live-events.js", async () => ({
  ...await vi.importActual<typeof import("../services/live-events.js")>("../services/live-events.js"),
  publishLiveEvent: vi.fn(),
}));
const supported = await getEmbeddedPostgresTestSupport();
const suite = supported.supported ? describe : describe.skip;
suite("atomic routine execution claim", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let release: (() => void) | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-routine-claim-atomicity-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(async () => {
    release?.();
    await heartbeat?.drainActiveRunExecutions();
    await db.execute(sql`truncate companies cascade`);
    vi.clearAllMocks();
  });
  afterAll(async () => { await database?.cleanup(); });
  async function row(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,id)))[0]!; }
  async function wait(check: () => Promise<boolean>) {
    await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 10_000, interval: 30 });
  }
  async function fixture(mode: "ordinary" | "automatic" | "comment" | "legacy_comment", options: Parameters<typeof heartbeatService>[1] = {}) {
    const companyId=randomUUID(), agentId=randomUUID(), originId=randomUUID();
    await db.insert(companies).values({id:companyId,name:"Atomic routine claim",issuePrefix:"ARC",defaultResponsibleUserId:"fixture-board",requireBoardApprovalForNewAgents:false});
    await db.insert(agents).values({id:agentId,companyId,name:"Claim fixture",role:"engineer",status:"active",adapterType:"process",adapterConfig:{},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:1}}});
    const ids={ ownerIssue:randomUUID(),contenderIssue:randomUUID(),ownerRun:randomUUID(),contenderRun:randomUUID(),ownerWake:randomUUID(),contenderWake:randomUUID(),comment:randomUUID() };
    await db.insert(issues).values([
      {id:ids.ownerIssue,companyId,title:"Existing routine owner",status:"todo",assigneeAgentId:agentId,originKind:"routine_execution",originId,originFingerprint:"same"},
      {id:ids.contenderIssue,companyId,title:"Earlier routine continuation",status:"in_progress",assigneeAgentId:agentId,originKind:"routine_execution",originId,originFingerprint:"same"},
    ]);
    const commentMode=mode==="comment"||mode==="legacy_comment";
    if(commentMode) await db.insert(issueComments).values({id:ids.comment,companyId,issueId:ids.contenderIssue,authorUserId:"fixture-board",body:"Retained queued comment"});
    const invocationSource=mode==="automatic"?"automation":"on_demand";
    await db.insert(agentWakeupRequests).values([
      {id:ids.ownerWake,companyId,agentId,source:"on_demand",triggerDetail:"manual",reason:"manual",status:"queued",payload:{issueId:ids.ownerIssue}},
      {id:ids.contenderWake,companyId,agentId,source:invocationSource,triggerDetail:"manual",reason:"issue_commented",status:"queued",payload:mode==="comment"?withQueuedCommentIdsInWakePayload({issueId:ids.contenderIssue},[ids.comment]):{issueId:ids.contenderIssue}},
    ]);
    await db.insert(heartbeatRuns).values([
      {id:ids.ownerRun,companyId,agentId,invocationSource:"on_demand",triggerDetail:"manual",status:"queued",wakeupRequestId:ids.ownerWake,contextSnapshot:{issueId:ids.ownerIssue,wakeReason:"manual"}},
      {id:ids.contenderRun,companyId,agentId,invocationSource,triggerDetail:"manual",status:"queued",wakeupRequestId:ids.contenderWake,contextSnapshot:{issueId:ids.contenderIssue,wakeReason:"issue_commented",...(commentMode?{wakeCommentIds:[ids.comment]}:{})}},
    ]);
    await db.update(agentWakeupRequests).set({runId:ids.ownerRun}).where(eq(agentWakeupRequests.id,ids.ownerWake));
    await db.update(agentWakeupRequests).set({runId:ids.contenderRun}).where(eq(agentWakeupRequests.id,ids.contenderWake));
    await db.update(issues).set({executionRunId:ids.ownerRun}).where(eq(issues.id,ids.ownerIssue));
    heartbeat=heartbeatService(db,{...options,runtimeEnv:{...process.env,PAPERCLIP_IN_WORKTREE:"false"}});
    return {companyId,agentId,...ids};
  }
  it.each(["ordinary","automatic","comment","legacy_comment"] as const)("defers %s contention atomically and dispatches owner then contender", async mode => {
    const f=await fixture(mode);
    const held=new Promise<void>(resolve=>{release=resolve;});
    execute.mockImplementation(async (context:{runId:string})=>{
      if(context.runId===f.ownerRun) await held;
      return {exitCode:0,signal:null,timedOut:false,errorMessage:null,summary:"Synthetic success",provider:"test",model:"fixture"};
    });
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    await wait(async()=>execute.mock.calls.some(([context])=>context.runId===f.ownerRun));
    expect(await row(f.contenderRun)).toMatchObject({status:"queued",startedAt:null,controllerBootId:null,controllerLeaseExpiresAt:null});
    const [wake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,f.contenderWake));
    expect(wake).toMatchObject({status:"queued",claimedAt:null});
    const [issue]=await db.select().from(issues).where(eq(issues.id,f.contenderIssue));
    expect(issue?.executionRunId).toBeNull();
    expect(vi.mocked(publishLiveEvent).mock.calls.some(([event])=>event.type==="heartbeat.run.status" && event.payload.runId===f.contenderRun && event.payload.status==="running")).toBe(false);
    expect(execute.mock.calls.filter(([context])=>context.runId===f.ownerRun)).toHaveLength(1);
    release!();
    await wait(async()=>execute.mock.calls.some(([context])=>context.runId===f.contenderRun));
    await heartbeat.drainActiveRunExecutions();
    expect((await row(f.contenderRun)).status).toBe("succeeded");
    expect(execute.mock.calls.filter(([context])=>context.runId===f.contenderRun)).toHaveLength(1);
  },20_000);
  it("rolls back the run and wake on unrelated issue binding failure without swallowing it", async () => {
    const f=await fixture("ordinary");
    await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.ownerIssue));
    await db.execute(sql.raw(`CREATE FUNCTION reject_fixture_issue_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.contenderIssue}' AND NEW.execution_run_id IS NOT NULL THEN RAISE EXCEPTION 'fixture-binding-failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_fixture_issue_binding BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION reject_fixture_issue_binding();`));
    try {
      await expect(heartbeat.resumeQueuedRuns()).rejects.toThrow();
      expect(await row(f.contenderRun)).toMatchObject({status:"queued",startedAt:null});
      const [wake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,f.contenderWake));
      expect(wake).toMatchObject({status:"queued",claimedAt:null});
      expect(execute).not.toHaveBeenCalled();
      expect(vi.mocked(publishLiveEvent).mock.calls.some(([event])=>event.type==="heartbeat.run.status" && event.payload.runId===f.contenderRun && event.payload.status==="running")).toBe(false);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER reject_fixture_issue_binding ON issues; DROP FUNCTION reject_fixture_issue_binding();"));
    }
  });

  it("does not claim after shutdown starts during awaited claim preflight", async () => {
    let entered!:()=>void, proceed!:()=>void;
    const atGate=new Promise<void>(resolve=>{entered=resolve;});
    const gate=new Promise<void>(resolve=>{proceed=resolve;});
    const f=await fixture("automatic", {beforeChatControlRecoveryCheck: async input=>{
      if(input.stage==="claim") {entered();await gate;}
    }});
    const pending=heartbeat.resumeQueuedRuns();
    await atGate;
    const shutdown = heartbeatService(db).prepareHotRestartShutdown("SIGTERM");
    proceed();
    await Promise.all([pending, shutdown]);
    expect(await row(f.contenderRun)).toMatchObject({status:"queued",startedAt:null});
    expect(await row(f.ownerRun)).toMatchObject({status:"queued",startedAt:null});
    expect(execute).not.toHaveBeenCalled();
    expect(vi.mocked(publishLiveEvent).mock.calls.some(([event])=>event.type==="heartbeat.run.status" && event.payload.status==="running")).toBe(false);
  });

  it("keeps shutdown closed across existing and new services after operator drain release", async () => {
    const f = await fixture("ordinary");
    await heartbeatService(db).prepareHotRestartShutdown("SIGTERM");
    stopTaskDrain();
    await heartbeat.resumeQueuedRuns();
    await heartbeatService(db).resumeQueuedRuns();
    expect(await row(f.ownerRun)).toMatchObject({ status: "queued", startedAt: null });
    expect(await row(f.contenderRun)).toMatchObject({ status: "queued", startedAt: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it("waits for another service's admitted transaction before the shutdown snapshot", async () => {
    const f = await fixture("ordinary");
    let entered!: () => void, proceed!: () => void;
    const beforeCommit = new Promise<void>(resolve => { entered = resolve; });
    const commitAllowed = new Promise<void>(resolve => { proceed = resolve; });
    const pausedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) => target.transaction(async tx => {
          const result = await fn(tx);
          const claimed = result as { id?: string; status?: string } | null;
          if (claimed?.id === f.ownerRun && claimed.status === "running") {
            // All callback checks have passed, but PostgreSQL has not committed.
            entered();
            await commitAllowed;
          }
          return result;
        });
      },
    }) as typeof db;
    const otherService = heartbeatService(pausedDb);
    const admission = otherService.resumeQueuedRuns();
    await beforeCommit;
    let snapshotEntered = false;
    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      waitForHeartbeatSchedulerIdle: async () => {},
      prepareHotRestartShutdown: async signal => {
        snapshotEntered = true;
        return heartbeat.prepareHotRestartShutdown(signal);
      },
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(snapshotEntered).toBe(false);
    expect(await row(f.ownerRun)).toMatchObject({ status: "queued", startedAt: null });
    proceed();
    await Promise.all([admission, shutdown]);
    await otherService.drainActiveRunExecutions();
    expect(snapshotEntered).toBe(true);
    expect(await row(f.ownerRun)).toMatchObject({ status: "queued", startedAt: null, controllerBootId: null });
    expect(await row(f.contenderRun)).toMatchObject({ status: "queued", startedAt: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it("dispatches an earlier committed claim when a later claim fails", async () => {
    const f=await fixture("ordinary");
    await db.update(agents).set({runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:2}}}).where(eq(agents.id,f.agentId));
    await db.update(issues).set({status:"in_progress",priority:"critical"}).where(eq(issues.id,f.ownerIssue));
    await db.update(issues).set({status:"todo",priority:"low"}).where(eq(issues.id,f.contenderIssue));
    const held=new Promise<void>(resolve=>{release=resolve;});
    execute.mockImplementation(async()=>{await held;return {exitCode:0,signal:null,timedOut:false,errorMessage:null,summary:"Synthetic success",provider:"test",model:"fixture"};});
    await db.execute(sql.raw(`CREATE FUNCTION reject_later_fixture_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.contenderIssue}' AND NEW.execution_run_id IS NOT NULL THEN RAISE EXCEPTION 'later-fixture-binding-failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_later_fixture_binding BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION reject_later_fixture_binding();`));
    try {
      await expect(heartbeat.resumeQueuedRuns()).rejects.toThrow();
      await wait(async()=>execute.mock.calls.some(([context])=>context.runId===f.ownerRun));
      expect(await row(f.contenderRun)).toMatchObject({status:"queued",startedAt:null});
      await heartbeat.prepareHotRestartShutdown("SIGTERM");
      release!();
      await heartbeat.drainActiveRunExecutions();
      expect((await row(f.ownerRun)).status).toBe("succeeded");
      expect(await row(f.contenderRun)).toMatchObject({status:"queued",startedAt:null});
    } finally {
      await db.execute(sql.raw("DROP TRIGGER reject_later_fixture_binding ON issues; DROP FUNCTION reject_later_fixture_binding();"));
    }
  });

  it("dispatches a committed claim despite a throwing live-event subscriber", async () => {
    const f=await fixture("ordinary");
    let thrown=false;
    vi.mocked(publishLiveEvent).mockImplementation(event=>{
      if(event.type==="heartbeat.run.status" && event.payload.runId===f.ownerRun && event.payload.status==="running" && !thrown) {thrown=true;throw new Error("fixture subscriber failure");}
    });
    execute.mockImplementation(async()=>({exitCode:0,signal:null,timedOut:false,errorMessage:null,summary:"Synthetic success",provider:"test",model:"fixture"}));
    try {
      await heartbeat.resumeQueuedRuns();
      await wait(async()=>execute.mock.calls.some(([context])=>context.runId===f.ownerRun));
      await heartbeat.drainActiveRunExecutions();
      expect(thrown).toBe(true);
      expect((await row(f.ownerRun)).status).toBe("succeeded");
    } finally {vi.mocked(publishLiveEvent).mockReset();}
  });

  it("releases in issue/wake/run lock order against an independent queue editor", async () => {
    const f=await fixture("ordinary");
    const boot=randomUUID();
    await db.update(heartbeatRuns).set({status:"running",startedAt:new Date(),controllerBootId:boot,controllerLeaseExpiresAt:new Date(Date.now()+60_000),executionStage:"preparing"}).where(eq(heartbeatRuns.id,f.ownerRun));
    await db.update(agentWakeupRequests).set({status:"claimed",claimedAt:new Date()}).where(eq(agentWakeupRequests.id,f.ownerWake));
    const other=createDb(database.connectionString);
    let pending!:Promise<void>;
    await db.transaction(async tx=>{
      await tx.select().from(issues).where(eq(issues.id,f.ownerIssue)).for("update");
      await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,f.ownerWake)).for("update");
      pending=releaseRunClaimedJustBeforeSuppression(other,f.ownerRun,boot);
      await wait(async()=>{
        const rows=await other.execute(sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as waiting`);
        return rows[0]?.waiting===true;
      });
      // The releaser must be waiting for our issue, not holding the run while
      // waiting for our wake. This NOWAIT acquisition proves the lock order.
      const rows=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.ownerRun)).for("update",{noWait:true});
      expect(rows[0]?.status).toBe("running");
    });
    await pending;
    expect(await row(f.ownerRun)).toMatchObject({status:"queued",startedAt:null,controllerBootId:null,controllerLeaseExpiresAt:null,executionStage:null});
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,f.ownerWake)))[0]).toMatchObject({status:"queued",claimedAt:null});
    expect((await db.select().from(issues).where(eq(issues.id,f.ownerIssue)))[0]?.executionRunId).toBeNull();
  });

  it.each(["foreign_controller","dispatched"] as const)("does not requeue a %s legacy owner", async condition=>{
    const f=await fixture("ordinary");const boot=randomUUID();
    await db.update(heartbeatRuns).set({status:"running",controllerBootId:condition==="foreign_controller"?randomUUID():boot,controllerLeaseExpiresAt:new Date(Date.now()+60_000),executionStage:condition==="dispatched"?"dispatching":"preparing",processPid:condition==="dispatched"?12345:null}).where(eq(heartbeatRuns.id,f.ownerRun));
    await releaseRunClaimedJustBeforeSuppression(db,f.ownerRun,boot);
    expect((await row(f.ownerRun)).status).toBe("running");
    // Test fixture has no actual provider. Restore terminal state for teardown.
    await db.update(heartbeatRuns).set({status:"cancelled",finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.ownerRun));
  });

});

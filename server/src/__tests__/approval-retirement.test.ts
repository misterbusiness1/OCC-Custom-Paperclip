import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, approvals, companies, createDb, heartbeatRuns, issueApprovals, issues } from "@paperclipai/db";
import { approvalService } from "../services/approvals.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";
import { setPluginEventBus } from "../services/activity-log.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const NOTE = "Retire obsolete closed work without agent execution";
const emit = vi.fn(async () => ({ errors: [] }));

describePostgres("explicit closed-request retirement", () => {
  let db!: ReturnType<typeof createDb>;
  let retiringDb!: typeof db;
  let racingDb!: typeof db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-retirement-");
    db = createDb(tempDb.connectionString);
    retiringDb = createDb(tempDb.connectionString, { maxConnections: 1, applicationName: "retirement-under-test" });
    racingDb = createDb(tempDb.connectionString, { maxConnections: 1, applicationName: "retirement-racer" });
    setPluginEventBus({ emit } as unknown as PluginEventBus);
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(statuses = ["done"], type = "request_board_approval") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retirement test", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Requester", status: "idle", adapterType: "process" }).returning();
    const [approval] = await db.insert(approvals).values({ companyId, type, status: "pending",
      requestedByAgentId: agent!.id, payload: { title: "Historical request" }, updatedAt: new Date() }).returning();
    const linked = [];
    for (const status of statuses) {
      const [issue] = await db.insert(issues).values({ companyId, title: "Historical task", status,
        assigneeAgentId: agent!.id, responsibleUserId: "board",
        completedAt: status === "done" ? new Date() : null, cancelledAt: status === "cancelled" ? new Date() : null }).returning();
      await db.insert(issueApprovals).values({ companyId, approvalId: approval!.id, issueId: issue!.id });
      linked.push(issue!);
    }
    return { companyId, agent: agent!, approval: approval!, linked };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const retire = (f: Fixture, targetDb = db) => approvalService(targetDb).retire(f.approval.id, f.companyId, "board", NOTE,
    { expectedUpdatedAt: f.approval.updatedAt });
  const read = (f: Fixture) => db.select().from(approvals).where(eq(approvals.id, f.approval.id)).then(rows => rows[0]!);
  const audit = (f: Fixture) => db.select().from(activityLog).where(eq(activityLog.entityId, f.approval.id));
  function app(companyId: string, agentId?: string) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = agentId ? { type: "agent", agentId, companyId } : {
        type: "board", source: "session", userId: "board", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false,
      }; next();
    });
    app.use("/api", approvalRoutes(db)); app.use(errorHandler); return app;
  }
  async function waitBlocked(applicationName: string, blockerPid: number) {
    const deadline = Date.now() + 5000;
    do {
      const rows = await db.execute(sql`select pid from pg_stat_activity where application_name = ${applicationName}
        and wait_event_type = 'Lock' and ${blockerPid} = any(pg_blocking_pids(pid))`);
      if (rows.length > 0) return Number(rows[0]!.pid);
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error(`Expected ${applicationName} to wait on backend ${blockerPid}`);
  }
  function latch() {
    let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  }

  it("retires both terminal statuses and publishes only committed non-plugin audit", async () => {
    const f = await seed(["done", "cancelled"]); emit.mockClear();
    const publications: Promise<unknown>[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => {
      if (event.type === "activity.logged") publications.push(audit(f));
    });
    try {
      const result = await retire(f);
      expect(result).toMatchObject({ applied: true, approval: { status: "rejected", decisionNote: NOTE } });
      const rows = await audit(f);
      expect(rows.map(row => row.action).sort()).toEqual(["approval.requester_wakeup_skipped", "approval.retired_closed_request"]);
      expect(rows.every(row => row.details?.executionSuppressed === true)).toBe(true);
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toEqual(f.linked);
      expect(await Promise.all(publications)).toEqual([rows, rows]);
      expect(emit).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it.each([[], ["todo"], ["in_review"], ["blocked"], ["done", "in_progress"]].map(statuses => ({ statuses })))("refuses an unlinked or open-linked request $statuses atomically", async ({ statuses }) => {
    const f = await seed(statuses);
    await expect(retire(f)).rejects.toMatchObject({ status: 409 });
    expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
  });

  it.each(["hire_agent", "approve_ceo_strategy", "budget_override_required"])("does not retire %s gates", async type => {
    const f = await seed(["done"], type);
    await expect(retire(f)).rejects.toMatchObject({ status: 422 });
    expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
  });

  it("rejects foreign link/issue scope without changing the pending approval", async () => {
    for (const field of ["link", "issue"] as const) {
      const f = await seed(); const foreign = await seed();
      if (field === "link") await db.update(issueApprovals).set({ companyId: foreign.companyId }).where(eq(issueApprovals.approvalId, f.approval.id));
      else await db.update(issues).set({ companyId: foreign.companyId }).where(eq(issues.id, f.linked[0]!.id));
      await expect(retire(f)).rejects.toMatchObject({ status: 409 });
      expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
    }
  });

  it.each(["executionRunId", "checkoutRunId"] as const)("preserves terminal work with a %s", async field => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "running" }).returning();
    await db.update(issues).set({ [field]: run!.id }).where(eq(issues.id, f.linked[0]!.id));
    await expect(retire(f)).rejects.toMatchObject({ status: 409 });
    expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
  });

  it("requires exact version; a repeat cannot relabel a normal rejection", async () => {
    const f = await seed();
    await expect(approvalService(db).retire(f.approval.id, f.companyId, "board", NOTE,
      { expectedUpdatedAt: new Date(f.approval.updatedAt.getTime() - 1) })).rejects.toMatchObject({ status: 409 });
    const first = await retire(f);
    await expect(retire(f)).rejects.toMatchObject({ status: 409 });
    await expect(approvalService(db).retire(f.approval.id, f.companyId, "board", NOTE,
      { expectedUpdatedAt: first.approval.updatedAt })).resolves.toMatchObject({ applied: false });
    expect(await audit(f)).toHaveLength(2);
    const ordinary = await seed(); const rejected = await approvalService(db).reject(ordinary.approval.id, "board", NOTE);
    await expect(approvalService(db).retire(ordinary.approval.id, ordinary.companyId, "board", NOTE,
      { expectedUpdatedAt: rejected.approval.updatedAt })).rejects.toMatchObject({ status: 409 });
    expect(await audit(ordinary)).toEqual([]);
  });

  it("commits only one of two simultaneous decisions naming the same version", async () => {
    const f = await seed();
    const results = await Promise.allSettled([retire(f, retiringDb), retire(f, racingDb)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find(result => result.status === "rejected");
    expect(refused).toMatchObject({ status: "rejected", reason: { status: 409 } });
    expect(await audit(f)).toHaveLength(2);
  });

  it("requires board company access, version and a reason at the API", async () => {
    const f = await seed(); const body = { decisionNote: NOTE, expectedUpdatedAt: f.approval.updatedAt.toISOString() };
    expect((await request(app(f.companyId, f.agent.id)).post(`/api/approvals/${f.approval.id}/retire`).send(body)).status).toBe(403);
    expect((await request(app(randomUUID())).post(`/api/approvals/${f.approval.id}/retire`).send(body)).status).toBe(404);
    for (const invalid of [{ decisionNote: NOTE }, { ...body, expectedUpdatedAt: "yesterday" }, { ...body, decisionNote: " " }, { ...body, status: "approved" }]) {
      expect((await request(app(f.companyId)).post(`/api/approvals/${f.approval.id}/retire`).send(invalid)).status).toBe(400);
    }
    expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
  });

  it("rolls back the decision and both publications if the second audit insert fails", async () => {
    const f = await seed(); const events: unknown[] = []; emit.mockClear();
    const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => events.push(event));
    await db.execute(sql`create function fail_retirement_audit() returns trigger language plpgsql as $$
      begin if NEW.action = 'approval.requester_wakeup_skipped' then raise exception 'audit failed'; end if; return NEW; end $$`);
    await db.execute(sql`create trigger fail_retirement_audit before insert on activity_log for each row execute function fail_retirement_audit()`);
    try {
      await expect(retire(f)).rejects.toThrow();
      expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
      expect(events).toEqual([]); expect(emit).not.toHaveBeenCalled();
    } finally {
      unsubscribe(); await db.execute(sql`drop trigger fail_retirement_audit on activity_log`);
      await db.execute(sql`drop function fail_retirement_audit()`);
    }
  });

  it("rechecks a reopen that won the issue lock and rolls the approval back", async () => {
    const f = await seed(); const locked = latch(); const release = latch(); let blockerPid = 0;
    const writer = racingDb.transaction(async tx => {
      blockerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await tx.update(issues).set({ status: "todo" }).where(eq(issues.id, f.linked[0]!.id));
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const result = retire(f, retiringDb).then(value => ({ value }), error => ({ error }));
    try { await waitBlocked("retirement-under-test", blockerPid); } finally { release.resolve(); }
    await writer; expect(await result).toMatchObject({ error: { status: 409 } });
    expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
  });

  it("sees an open link inserted before it acquires the approval FK lock", async () => {
    const f = await seed(); const [open] = await db.insert(issues).values({ companyId: f.companyId, title: "Still live", status: "todo" }).returning();
    const inserted = latch(); const release = latch(); let blockerPid = 0;
    const writer = racingDb.transaction(async tx => {
      blockerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await tx.insert(issueApprovals).values({ companyId: f.companyId, approvalId: f.approval.id, issueId: open!.id });
      inserted.resolve(); await release.promise;
    });
    await inserted.promise;
    const result = retire(f, retiringDb).then(value => ({ value }), error => ({ error }));
    try { await waitBlocked("retirement-under-test", blockerPid); } finally { release.resolve(); }
    await writer; expect(await result).toMatchObject({ error: { status: 409 } });
    expect(await read(f)).toEqual(f.approval); expect(await audit(f)).toEqual([]);
  });

  it.each(["link", "unlink", "reopen"] as const)("holds concurrent %s behind its eligibility snapshot until commit", async action => {
    const f = await seed(); const [open] = await db.insert(issues).values({ companyId: f.companyId, title: "New task", status: "todo" }).returning();
    const locked = latch(); const release = latch(); let blockerPid = 0;
    const holder = db.transaction(async tx => {
      blockerPid = Number((await tx.execute(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await tx.select().from(issues).where(eq(issues.id, f.linked[0]!.id)).for("update");
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const retirement = retire(f, retiringDb);
    let change: Promise<unknown> | undefined;
    try {
      const retirementPid = await waitBlocked("retirement-under-test", blockerPid);
      change = action === "link"
        ? racingDb.insert(issueApprovals).values({ companyId: f.companyId, approvalId: f.approval.id, issueId: open!.id }).then(rows => rows)
        : action === "unlink"
          ? racingDb.delete(issueApprovals).where(and(eq(issueApprovals.approvalId, f.approval.id), eq(issueApprovals.issueId, f.linked[0]!.id))).then(rows => rows)
          : racingDb.update(issues).set({ status: "todo" }).where(eq(issues.id, f.linked[0]!.id)).then(rows => rows);
      await waitBlocked("retirement-racer", retirementPid);
    } finally { release.resolve(); }
    await holder; expect(await retirement).toMatchObject({ applied: true }); await change;
    expect((await audit(f)).every(row => JSON.stringify(row.details?.linkedIssueIds) === JSON.stringify([f.linked[0]!.id]))).toBe(true);
  });
});

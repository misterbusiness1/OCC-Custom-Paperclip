import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agentApiKeys, agents, approvals, budgetPolicies, companies, companySecretBindings, companySecrets, createDb } from "@paperclipai/db";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const notifyHireApproved = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved }));

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("S2 hire approval target integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hire-target-integrity-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => { notifyHireApproved.mockReset(); });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Hire target test", issuePrefix: `T${id.slice(0, 6).toUpperCase()}` });
    return id;
  }

  async function agent(companyId: string, status = "pending_approval") {
    const [row] = await db.insert(agents).values({
      companyId, name: `Candidate ${randomUUID()}`, status,
      adapterType: "process", adapterConfig: { command: "original" },
    }).returning();
    const [key] = await db.insert(agentApiKeys).values({
      companyId, agentId: row!.id, name: "Test key", keyHash: randomUUID(),
    }).returning();
    return { row: row!, key: key! };
  }

  async function hire(companyId: string, agentId?: string, payload: Record<string, unknown> = {}) {
    return approvalService(db).create(companyId, {
      type: "hire_agent", payload: { ...(agentId ? { agentId } : {}), ...payload }, updatedAt: new Date(),
    });
  }

  const readApproval = (id: string) => db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0]!);
  const readAgent = (id: string) => db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0]!);
  const readKey = (id: string) => db.select().from(agentApiKeys).where(eq(agentApiKeys.id, id)).then((rows) => rows[0]!);

  // Real writes from a second connection land after the approval pre-read and
  // before its guarded UPDATE; the decision must use the row actually updated.
  function racingDb(afterFirstRead: () => Promise<unknown>) {
    const racing = Object.create(db) as typeof db;
    let reads = 0;
    racing.select = ((...args: Parameters<typeof db.select>) => {
      const builder = db.select(...args);
      if (++reads !== 1) return builder;
      return {
        from: (table: Parameters<typeof builder.from>[0]) => ({
          where: (condition: Parameters<ReturnType<typeof builder.from>["where"]>[0]) =>
            (builder.from(table) as any).where(condition).then(async (rows: unknown[]) => {
              await afterFirstRead();
              return rows;
            }),
        }),
      };
    }) as typeof db.select;
    return racing;
  }

  for (const decision of ["approve", "reject"] as const) {
    it(`${decision} refuses a foreign pending target and rolls back the decision`, async () => {
      const companyId = await company();
      const target = await agent(await company());
      const approval = await hire(companyId, target.row.id, { adapterConfig: { command: "replacement" } });

      await expect(approvalService(db)[decision](approval.id, "board")).rejects.toMatchObject({ status: 409 });

      expect(await readApproval(approval.id)).toEqual(approval);
      expect(await readAgent(target.row.id)).toEqual(target.row);
      expect(await readKey(target.key.id)).toEqual(target.key);
      expect(notifyHireApproved).not.toHaveBeenCalled();
    });

    it.each(["idle", "active", "running", "paused", "error", "terminated"])(`${decision} refuses a same-company %s target without any mutation`, async (status) => {
      const companyId = await company();
      const target = await agent(companyId, status);
      const approval = await hire(companyId, target.row.id, { adapterConfig: { command: "replacement" } });

      await expect(approvalService(db)[decision](approval.id, "board")).rejects.toMatchObject({ status: 409 });

      expect(await readApproval(approval.id)).toEqual(approval);
      expect(await readAgent(target.row.id)).toEqual(target.row);
      expect(await readKey(target.key.id)).toEqual(target.key);
      expect(notifyHireApproved).not.toHaveBeenCalled();
    });

    it(`${decision} refuses a missing target without deciding the approval`, async () => {
      const approval = await hire(await company(), randomUUID());
      await expect(approvalService(db)[decision](approval.id, "board")).rejects.toMatchObject({ status: 409 });
      expect(await readApproval(approval.id)).toEqual(approval);
      expect(notifyHireApproved).not.toHaveBeenCalled();
    });

    it.each(["", "not-a-uuid", 42])(`${decision} refuses malformed explicit target %j without creating an agent`, async (agentId) => {
      const companyId = await company();
      const approval = await hire(companyId, undefined, { agentId });
      await expect(approvalService(db)[decision](approval.id, "board")).rejects.toMatchObject({ status: 409 });
      expect(await readApproval(approval.id)).toEqual(approval);
      expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toEqual([]);
    });

    it(`${decision} transitions a pending target exactly once`, async () => {
      const companyId = await company();
      const target = await agent(companyId);
      const approval = await hire(companyId, target.row.id, { adapterConfig: { command: "approved" } });
      const svc = approvalService(db);

      await expect(svc[decision](approval.id, "board")).resolves.toMatchObject({ applied: true });
      const targetAfter = await readAgent(target.row.id);
      expect(targetAfter.status).toBe(decision === "approve" ? "idle" : "terminated");
      expect((await readKey(target.key.id)).revokedAt === null).toBe(decision === "approve");
      await expect(svc[decision](approval.id, "board")).resolves.toMatchObject({ applied: false });
      expect(await readAgent(target.row.id)).toEqual(targetAfter);
      expect(notifyHireApproved).toHaveBeenCalledTimes(decision === "approve" ? 1 : 0);
    });
  }

  it("keeps direct board activation and company-local creation without agentId", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    await expect(agentService(db).activatePendingApproval(companyId, target.row.id)).resolves.toMatchObject({ activated: true });
    const approval = await hire(companyId, undefined, { name: "Created from hire", adapterType: "process" });
    await expect(approvalService(db).approve(approval.id, "board")).resolves.toMatchObject({ applied: true });
    const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(rows.find((row) => row.name === "Created from hire")).toMatchObject({ companyId, status: "idle" });
  });

  it("rolls back the approval when approved configuration cannot be persisted", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const approval = await hire(companyId, target.row.id, { reportsTo: randomUUID() });
    await expect(approvalService(db).approve(approval.id, "board")).rejects.toThrow();
    expect(await readApproval(approval.id)).toEqual(approval);
    expect(await readAgent(target.row.id)).toEqual(target.row);
    expect(notifyHireApproved).not.toHaveBeenCalled();
  });

  it("rolls back rejection and target status when API key revocation fails", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const approval = await hire(companyId, target.row.id);
    await db.execute(sql`create function fail_hire_key_revoke() returns trigger language plpgsql as $$
      begin raise exception 'test revocation failure'; end $$`);
    await db.execute(sql`create trigger fail_hire_key_revoke before update on agent_api_keys
      for each row execute function fail_hire_key_revoke()`);
    try {
      await expect(approvalService(db).reject(approval.id, "board")).rejects.toThrow();
      expect(await readApproval(approval.id)).toEqual(approval);
      expect(await readAgent(target.row.id)).toEqual(target.row);
      expect(await readKey(target.key.id)).toEqual(target.key);
    } finally {
      await db.execute(sql`drop trigger fail_hire_key_revoke on agent_api_keys`);
      await db.execute(sql`drop function fail_hire_key_revoke()`);
    }
  });

  it("rolls back activation and approval when the budget policy cannot be written", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const approval = await hire(companyId, target.row.id, { budgetMonthlyCents: 1200 });
    await db.execute(sql`create function fail_hire_budget() returns trigger language plpgsql as $$
      begin raise exception 'test budget failure'; end $$`);
    await db.execute(sql`create trigger fail_hire_budget before insert on budget_policies
      for each row execute function fail_hire_budget()`);
    try {
      await expect(approvalService(db).approve(approval.id, "board")).rejects.toThrow();
      expect(await readApproval(approval.id)).toEqual(approval);
      expect(await readAgent(target.row.id)).toEqual(target.row);
      expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).toEqual([]);
      expect(notifyHireApproved).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`drop trigger fail_hire_budget on budget_policies`);
      await db.execute(sql`drop function fail_hire_budget()`);
    }
  });

  it("publishes the budget event only when its approval and target are visible after commit", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const approval = await hire(companyId, target.row.id, { budgetMonthlyCents: 1200 });
    const observations: Promise<string[]>[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.payload.action === "budget.policy_upserted") {
        observations.push(Promise.all([readApproval(approval.id), readAgent(target.row.id)])
          .then((rows) => rows.map((row) => row.status)));
      }
    });
    // Drain any event consumer reads before committing. An early publication
    // deterministically observes the original rows through a second connection.
    const observedDb = Object.create(db) as typeof db;
    observedDb.transaction = ((run: Parameters<typeof db.transaction>[0]) => db.transaction(async (tx) => {
      const result = await run(tx);
      await Promise.all(observations);
      return result;
    })) as typeof db.transaction;
    try {
      await approvalService(observedDb).approve(approval.id, "board");
      expect(await Promise.all(observations)).toEqual([["approved", "idle"]]);
    } finally { unsubscribe(); }
  });

  it("discards the budget publication when the decision transaction fails at commit", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const approval = await hire(companyId, target.row.id, { budgetMonthlyCents: 1200 });
    const events: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.payload.action === "budget.policy_upserted") events.push(event);
    });
    await db.execute(sql`create function fail_hire_commit() returns trigger language plpgsql as $$
      begin raise exception 'test commit failure'; end $$`);
    await db.execute(sql`create constraint trigger fail_hire_commit after insert on budget_policies
      deferrable initially deferred for each row execute function fail_hire_commit()`);
    try {
      await expect(approvalService(db).approve(approval.id, "board")).rejects.toThrow();
      expect(await readApproval(approval.id)).toEqual(approval);
      expect(await readAgent(target.row.id)).toEqual(target.row);
      expect(events).toEqual([]);
      expect(notifyHireApproved).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await db.execute(sql`drop trigger fail_hire_commit on budget_policies`);
      await db.execute(sql`drop function fail_hire_commit()`);
    }
  });

  for (const targetKind of ["existing", "new"] as const) {
    async function secretHire() {
      const companyId = await company();
      const target = targetKind === "existing" ? await agent(companyId) : null;
      const [secret] = await db.insert(companySecrets).values({
        companyId, name: "Test binding metadata", key: "TEST_BINDING",
      }).returning();
      const approval = await hire(companyId, target?.row.id, {
        adapterType: "process", budgetMonthlyCents: 1200,
        adapterConfig: { env: { API_KEY: { type: "secret_ref", secretId: secret!.id, version: "latest" } } },
      });
      return { companyId, target, approval };
    }

    it(`publishes ${targetKind} hire secret bindings only after the outer decision commits`, async () => {
      const { companyId, approval } = await secretHire();
      const observations: Promise<string[]>[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        if (event.payload.action === "secret.binding.created") {
          observations.push(Promise.all([readApproval(approval.id), readAgent(String(event.payload.entityId))])
            .then((rows) => rows.map((row) => row?.status ?? "missing")));
        }
      });
      const observedDb = Object.create(db) as typeof db;
      observedDb.transaction = ((run: Parameters<typeof db.transaction>[0]) => db.transaction(async (tx) => {
        const result = await run(tx);
        await Promise.all(observations);
        return result;
      })) as typeof db.transaction;
      try {
        await approvalService(observedDb).approve(approval.id, "board");
        expect(await Promise.all(observations)).toEqual([["approved", "idle"]]);
      } finally { unsubscribe(); }
    });

    it(`discards ${targetKind} hire secret-binding publication on a later budget rollback`, async () => {
      const { companyId, target, approval } = await secretHire();
      const events: unknown[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        if (event.payload.action === "secret.binding.created") events.push(event);
      });
      await db.execute(sql`create function fail_secret_hire_budget() returns trigger language plpgsql as $$
        begin raise exception 'test budget after binding failure'; end $$`);
      await db.execute(sql`create trigger fail_secret_hire_budget before insert on budget_policies
        for each row execute function fail_secret_hire_budget()`);
      try {
        await expect(approvalService(db).approve(approval.id, "board")).rejects.toThrow();
        expect(await readApproval(approval.id)).toEqual(approval);
        expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toEqual(target ? [target.row] : []);
        expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).toEqual([]);
        expect(events).toEqual([]);
        expect(notifyHireApproved).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        await db.execute(sql`drop trigger fail_secret_hire_budget on budget_policies`);
        await db.execute(sql`drop function fail_secret_hire_budget()`);
      }
    });
  }

  for (const decision of ["approve", "reject"] as const) {
    it(`${decision} validates the resubmitted target from the guarded UPDATE`, async () => {
      const companyId = await company();
      const original = await agent(companyId);
      const foreign = await agent(await company());
      const approval = await hire(companyId, original.row.id);
      const svc = approvalService(db);
      let revised = approval;
      const racing = racingDb(async () => {
        await svc.requestRevision(approval.id, "board");
        revised = await svc.resubmit(approval.id, { agentId: foreign.row.id });
      });

      await expect(approvalService(racing)[decision](approval.id, "board")).rejects.toMatchObject({ status: 409 });

      expect(await readApproval(approval.id)).toEqual(revised);
      expect(await readAgent(original.row.id)).toEqual(original.row);
      expect(await readAgent(foreign.row.id)).toEqual(foreign.row);
      expect(await readKey(foreign.key.id)).toEqual(foreign.key);
      expect(notifyHireApproved).not.toHaveBeenCalled();
    });
  }

  it("uses the latest same-company target for an unversioned resubmission race", async () => {
    const companyId = await company();
    const original = await agent(companyId);
    const replacement = await agent(companyId);
    const approval = await hire(companyId, original.row.id);
    const racing = racingDb(async () => {
      await approvalService(db).requestRevision(approval.id, "board");
      await approvalService(db).resubmit(approval.id, { agentId: replacement.row.id });
    });
    await expect(approvalService(racing).approve(approval.id, "board")).resolves.toMatchObject({ applied: true });
    expect(await readAgent(original.row.id)).toEqual(original.row);
    expect((await readAgent(replacement.row.id)).status).toBe("idle");
    expect((await readApproval(approval.id)).payload.agentId).toBe(replacement.row.id);
  });

  it("refuses a versioned resubmission race without activating either target", async () => {
    const companyId = await company();
    const original = await agent(companyId);
    const replacement = await agent(companyId);
    const approval = await hire(companyId, original.row.id);
    const racing = racingDb(async () => {
      await approvalService(db).requestRevision(approval.id, "board");
      await approvalService(db).resubmit(approval.id, { agentId: replacement.row.id });
    });
    await expect(approvalService(racing).approve(approval.id, "board", null, {
      expectedUpdatedAt: approval.updatedAt,
    })).rejects.toMatchObject({ status: 409, details: { code: "approval_version_conflict" } });
    expect(await readAgent(original.row.id)).toEqual(original.row);
    expect(await readAgent(replacement.row.id)).toEqual(replacement.row);
    expect((await readApproval(approval.id)).status).toBe("pending");
  });

  it("lets only one competing approve/reject decision change the target", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const approval = await hire(companyId, target.row.id);
    const svc = approvalService(db);
    const results = await Promise.allSettled([svc.approve(approval.id, "board-a"), svc.reject(approval.id, "board-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 422 } });
    const approved = (await readApproval(approval.id)).status === "approved";
    expect((await readAgent(target.row.id)).status).toBe(approved ? "idle" : "terminated");
    expect((await readKey(target.key.id)).revokedAt === null).toBe(approved);
    expect(notifyHireApproved).toHaveBeenCalledTimes(approved ? 1 : 0);
  });

  it("rolls back the losing approval when two approvals target one pending agent", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const first = await hire(companyId, target.row.id);
    const second = await hire(companyId, target.row.id);
    const svc = approvalService(db);
    const results = await Promise.allSettled([svc.approve(first.id, "board-a"), svc.reject(second.id, "board-b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const stored = [await readApproval(first.id), await readApproval(second.id)];
    expect(stored.filter((row) => row.status === "pending")).toHaveLength(1);
    expect((await readAgent(target.row.id)).status).toBe(stored[0]!.status === "approved" ? "idle" : "terminated");
  });

  it("notifies the adapter only after both decision and activation are committed", async () => {
    const companyId = await company();
    const target = await agent(companyId);
    const approval = await hire(companyId, target.row.id);
    let observed: Promise<string[]> | undefined;
    notifyHireApproved.mockImplementationOnce(async () => {
      observed = Promise.all([readApproval(approval.id), readAgent(target.row.id)]).then((rows) => rows.map((row) => row.status));
      await observed;
    });
    await approvalService(db).approve(approval.id, "board");
    expect(observed).toBeDefined();
    expect(await observed).toEqual(["approved", "idle"]);
  });
});

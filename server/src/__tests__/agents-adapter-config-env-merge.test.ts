import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  userSecretDeclarations,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent adapter-config env merge route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PLAIN_KEY = "PLAIN_APP_KEY";
const SECRET_KEY = "SECRET_APP_KEY";

type Db = ReturnType<typeof createDb>;

const boardActor: Express.Request["actor"] = {
  type: "board",
  userId: "board-user",
  companyIds: [COMPANY_ID],
  memberships: [
    {
      companyId: COMPANY_ID,
      membershipRole: "owner",
      status: "active",
    },
  ],
  isInstanceAdmin: true,
  source: "local_implicit",
};

describeEmbeddedPostgres("agent adapter-config environment binding merge", () => {
  let db!: Db;
  let stopDb: (() => Promise<void>) | null = null;
  let secretsTmpDir = "";
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  let secretId = "";

  beforeAll(async () => {
    secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-env-merge-${randomUUID()}`);
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-env-merge-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Acme",
      issuePrefix: "ACME",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: COMPANY_ID,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  beforeEach(async () => {
    await db.delete(activityLog);
    const secret = await secretService(db).create(COMPANY_ID, {
      name: `company-app-secret-${randomUUID().slice(0, 8)}`,
      provider: "local_encrypted",
      value: "secret-value",
    });
    secretId = secret.id;
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
  });

  afterAll(async () => {
    if (stopDb) await stopDb();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = boardActor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedAgent() {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: COMPANY_ID,
        name: `Env Merge ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "plain-value" },
            [SECRET_KEY]: { type: "secret_ref", secretId, version: "latest" },
          },
        },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    if (!agent) throw new Error("failed to seed agent");
    return agent;
  }

  async function storedEnv(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    const config = (row?.adapterConfig ?? {}) as Record<string, unknown>;
    return (config.env ?? {}) as Record<string, unknown>;
  }

  it("keeps every stored binding when a PATCH carries a partial env map", async () => {
    const agent = await seedAgent();
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "***REDACTED***" },
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const env = await storedEnv(agent.id);
    // The plain binding the request mentioned keeps its stored value, and the
    // secret binding the request did not mention is still bound.
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toMatchObject({ type: "secret_ref", secretId, version: "latest" });
  });

  it("keeps every stored binding when a PATCH replaces the adapter config with a partial env map", async () => {
    const agent = await seedAgent();
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({
        replaceAdapterConfig: true,
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "plain-value" },
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toMatchObject({ type: "secret_ref", secretId, version: "latest" });
  });

  it("keeps every stored binding when a PATCH carries no env map at all", async () => {
    const agent = await seedAgent();
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { model: "claude-sonnet-4-6" } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toMatchObject({ type: "secret_ref", secretId, version: "latest" });
  });

  const fixedBinding = { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" };

  it.each([
    { adapterType: "process" },
    { adapterType: "process", adapterConfig: { command: "echo" } },
    { adapterType: "process", adapterConfig: { env: {} } },
    { adapterType: "process", adapterConfig: { env: {
      [PLAIN_KEY]: { type: "plain", value: "***REDACTED***" },
    } } },
  ])("drops an omitted fixed binding on transition: %j", async (patch) => {
    const agent = await seedAgent();
    const env = await storedEnv(agent.id);
    await db.update(agents).set({ adapterConfig: {
      env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: fixedBinding },
    } }).where(eq(agents.id, agent.id));
    // Materialize the fixed user-secret declaration through the real service.
    await agentService(db).update(agent.id, { adapterConfig: { env: {
      ...env, CLAUDE_CODE_OAUTH_TOKEN: fixedBinding,
    } } });
    const beforeDeclarations = await db.select().from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.targetId, agent.id));
    expect(beforeDeclarations).toHaveLength(1);
    await db.insert(agentRuntimeState).values({
      agentId: agent.id, companyId: COMPANY_ID, adapterType: "claude_local",
      sessionId: "synthetic-session", stateJson: { synthetic: true },
    });

    const res = await request(createApp()).patch(`/api/agents/${agent.id}`).send(patch);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const persisted = await storedEnv(agent.id);
    expect(persisted.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(persisted[PLAIN_KEY]).toEqual(env[PLAIN_KEY]);
    expect(persisted[SECRET_KEY]).toMatchObject(env[SECRET_KEY]);
    const [runtime] = await db.select().from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agent.id));
    expect(runtime).toMatchObject({ adapterType: "process", sessionId: null, stateJson: {} });
    const declarations = await db.select().from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.targetId, agent.id));
    expect(declarations).toHaveLength(0);
  });

  it("forwards an explicitly supplied fixed binding under existing policy", async () => {
    const agent = await seedAgent();
    const env = await storedEnv(agent.id);
    await db.update(agents).set({ adapterConfig: {
      env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: fixedBinding },
    } }).where(eq(agents.id, agent.id));
    const res = await request(createApp()).patch(`/api/agents/${agent.id}`).send({
      adapterType: "process", adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: fixedBinding } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await storedEnv(agent.id)).CLAUDE_CODE_OAUTH_TOKEN).toMatchObject(fixedBinding);
  });

  it("ignores an unknown top-level field instead of failing the write", async () => {
    const agent = await seedAgent();
    const app = createApp();

    // The update schema keeps unknown top-level fields, so a new field a
    // caller sends reaches the handler instead of being stripped. The agent
    // table has no column for it, so the write must ignore it rather than
    // fail the whole request.
    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "plain-value" },
          },
        },
        someFieldTheSchemaDoesNotKnowAbout: "ignored",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toMatchObject({ type: "secret_ref", secretId, version: "latest" });
  });

  it("removes a binding only when the request names it, and records the removal", async () => {
    const agent = await seedAgent();
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "plain-value" },
          },
        },
        envRemovedKeys: [SECRET_KEY],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toBeUndefined();

    const events = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.adapter_config_env_removed")));
    expect(events.length).toBe(1);
    const details = events[0].details as Record<string, unknown>;
    expect(details.removedKeys).toEqual([SECRET_KEY]);
    // The record names the binding kind, never its value.
    expect(details.removedBindings).toEqual([{ key: SECRET_KEY, kind: "secret_ref" }]);
    expect(JSON.stringify(details)).not.toContain("secret-value");
  });

  it("refuses to remove a binding that is not bound on the agent", async () => {
    const agent = await seedAgent();
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({ adapterConfig: { env: {} }, envRemovedKeys: ["NOT_BOUND_KEY"] });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toMatchObject({ type: "secret_ref", secretId, version: "latest" });
  });

  it("refuses to set and remove the same binding in one request", async () => {
    const agent = await seedAgent();
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agent.id}`)
      .send({
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "plain-value" },
          },
        },
        envRemovedKeys: [PLAIN_KEY],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
  });

  it("keeps a secret binding when a service-level write omits it", async () => {
    const agent = await seedAgent();

    // The merge lives in the service layer, so a write that does not go
    // through the HTTP route - the platform's own built-in agent
    // reconciliation, for example - cannot drop a binding either. The write
    // succeeds and the omitted binding keeps its stored value.
    await agentService(db).update(
      agent.id,
      {
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "plain-value" },
          },
        },
      },
      { envUpdate: { removals: [] } },
    );

    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toMatchObject({ type: "secret_ref", secretId, version: "latest" });
  });

  it("allows a service-level write that drops a secret binding with an explicit removal", async () => {
    const agent = await seedAgent();

    await agentService(db).update(
      agent.id,
      {
        adapterConfig: {
          env: {
            [PLAIN_KEY]: { type: "plain", value: "plain-value" },
          },
        },
      },
      { envUpdate: { removals: [SECRET_KEY] } },
    );

    const env = await storedEnv(agent.id);
    expect(env[PLAIN_KEY]).toMatchObject({ type: "plain", value: "plain-value" });
    expect(env[SECRET_KEY]).toBeUndefined();
  });

  async function runContendingOperations(agentId: string, operations: Array<() => Promise<unknown>>) {
    let unlock!: () => void;
    let locked!: () => void;
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("update");
      locked();
      await release;
    });
    await ready;
    const updates: Promise<unknown>[] = [];
    try {
      for (const operation of operations) {
        updates.push(operation());
        // Enqueue in a known order at the actual PostgreSQL row-lock boundary.
        // Old code has already read stale config here; fixed code locks first.
        const deadline = Date.now() + 5000;
        for (;;) {
          const rows = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query like '%agents%'`);
          if (Number(rows[0]?.waiting) >= updates.length) break;
          if (Date.now() > deadline) throw new Error("Concurrent agent updates did not reach row-lock boundary");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } finally {
      unlock();
      await holder;
    }
    return await Promise.all(updates);
  }

  async function runContendingUpdates(agentId: string, patches: Array<Parameters<ReturnType<typeof agentService>["update"]>[1]>, removals: string[][] = []) {
    return runContendingOperations(agentId, patches.map((patch, index) => () => agentService(db).update(agentId, patch, {
      envUpdate: { removals: removals[index] ?? [] },
      recordRevision: { source: "patch" },
    })));
  }

  it("preserves both independent environment additions under concurrent service updates", async () => {
    const agent = await seedAgent();
    await runContendingUpdates(agent.id, [
      { adapterConfig: { env: { FIRST: { type: "plain", value: "first" } } } },
      { adapterConfig: { env: { SECOND: { type: "plain", value: "second" } } } },
    ]);
    const env = await storedEnv(agent.id);
    expect(env.FIRST).toEqual({ type: "plain", value: "first" });
    expect(env.SECOND).toEqual({ type: "plain", value: "second" });
    expect(env[SECRET_KEY]).toMatchObject({ secretId });
  });

  it("does not resurrect an explicit removal or lose a concurrent unrelated addition", async () => {
    const agent = await seedAgent();
    await runContendingUpdates(agent.id, [
      { adapterConfig: { env: {} } },
      { adapterConfig: { env: { ADDED: { type: "plain", value: "new" } } } },
    ], [[SECRET_KEY], []]);
    const env = await storedEnv(agent.id);
    expect(env[SECRET_KEY]).toBeUndefined();
    expect(env.ADDED).toEqual({ type: "plain", value: "new" });
  });


  it("does not replay a route snapshot after a concurrent secret removal", async () => {
    const agent = await seedAgent();
    const app = createApp();
    const results = await runContendingOperations(agent.id, [
      () => agentService(db).update(agent.id, { adapterConfig: { env: {} } }, { envUpdate: { removals: [SECRET_KEY] } }),
      () => request(app).patch(`/api/agents/${agent.id}`).send({ adapterConfig: { env: { ROUTE_ADDED: { type: "plain", value: "route" } } } }).then((response) => {
        expect(response.status).toBe(200);
        return response.body;
      }),
    ]);
    expect(results).toHaveLength(2);
    const env = await storedEnv(agent.id);
    expect(env[SECRET_KEY]).toBeUndefined();
    expect(env.ROUTE_ADDED).toEqual({ type: "plain", value: "route" });
  });

  it.each(["remove", "rotate"] as const)("instructions-only route does not replay env after concurrent %s", async (change) => {
    const agent = await seedAgent();
    const app = createApp();
    await runContendingOperations(agent.id, [
      () => change === "remove"
        ? agentService(db).update(agent.id, { adapterConfig: { env: {} } }, { envUpdate: { removals: [SECRET_KEY] } })
        : agentService(db).update(agent.id, { adapterConfig: { env: { [PLAIN_KEY]: { type: "plain", value: "rotated" } } } }),
      () => request(app).patch(`/api/agents/${agent.id}/instructions-path`)
        .send({ path: "/tmp/synthetic-concurrent-instructions.md" }).then((response) => {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
        }),
    ]);
    const env = await storedEnv(agent.id);
    if (change === "remove") expect(env[SECRET_KEY]).toBeUndefined();
    else expect(env[PLAIN_KEY]).toEqual({ type: "plain", value: "rotated" });
    const updated = await agentService(db).getById(agent.id);
    expect((updated!.adapterConfig as Record<string, unknown>).instructionsFilePath)
      .toBe("/tmp/synthetic-concurrent-instructions.md");
  });

  it("treats a redacted route placeholder as preserve-current during a concurrent change", async () => {
    const agent = await seedAgent();
    const app = createApp();
    await runContendingOperations(agent.id, [
      () => agentService(db).update(agent.id, { adapterConfig: { env: { [PLAIN_KEY]: { type: "plain", value: "changed" } } } }),
      () => request(app).patch(`/api/agents/${agent.id}`).send({ adapterConfig: { env: { [PLAIN_KEY]: { type: "plain", value: REDACTED_EVENT_VALUE } } } }).then((response) => {
        expect(response.status).toBe(200);
      }),
    ]);
    expect((await storedEnv(agent.id))[PLAIN_KEY]).toEqual({ type: "plain", value: "changed" });
  });


  it("computes deliberate rollback removals from the locked current configuration", async () => {
    const agent = await seedAgent();
    const service = agentService(db);
    await service.update(agent.id, { name: "Rollback snapshot" }, { recordRevision: { source: "patch" } });
    const [revision] = await service.listConfigRevisions(agent.id);
    expect(revision).toBeDefined();
    await runContendingOperations(agent.id, [
      () => service.update(agent.id, { adapterConfig: { env: { AFTER_SNAPSHOT: { type: "plain", value: "new" } } } }),
      () => service.rollbackConfigRevision(agent.id, revision!.id, { userId: "board-user" }),
    ]);
    const env = await storedEnv(agent.id);
    expect(env.AFTER_SNAPSHOT).toBeUndefined();
    expect(env[SECRET_KEY]).toMatchObject({ secretId });
  });

});

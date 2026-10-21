import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent secret binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service secret binding sync", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-secret-bindings-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-bindings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("creates agent secret bindings when a new agent persists secret_ref env", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `anthropic-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sk-ant-123",
    });

    const created = await agentService(db).create(companyId, {
      name: "Claude Novita",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
      versionSelector: "latest",
      required: true,
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "secret.binding.created",
          entityType: "agent",
          entityId: created.id,
          details: expect.objectContaining({ configPath: "env.ANTHROPIC_API_KEY" }),
        }),
      ]));
  });

  it("stores approved class-3 env lease metadata on agent secret bindings", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `slack-${randomUUID()}`,
      provider: "local_encrypted",
      value: "slack-test-token",
    });

    const created = await agentService(db).create(companyId, {
      name: "Slack Briefing",
      role: "briefing",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          SLACK_BOT_TOKEN: {
            type: "secret_ref",
            secretId: secret.id,
            version: "latest",
            projectionClass: "class_3_static_lease",
            projectionAllowlistKey: "slack.bot_token",
          },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.SLACK_BOT_TOKEN",
      projectionClass: "class_3_static_lease",
      projectionAllowlistKey: "slack.bot_token",
    });
  });

  it("rejects class-3 env lease bindings outside the enumerated allowlist", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `github-${randomUUID()}`,
      provider: "local_encrypted",
      value: "github-test-token",
    });

    await expect(
      agentService(db).create(companyId, {
        name: "Unlisted Static Lease",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            GITHUB_TOKEN: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
              projectionClass: "class_3_static_lease",
              projectionAllowlistKey: "github.token",
            },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "class_3_static_lease_not_allowed" },
    });

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("converts Hermes gateway apiKey strings into persisted secret refs", async () => {
    const companyId = await seedCompany();
    const literalApiKey = `hermes-key-${randomUUID()}`;

    const created = await agentService(db).create(companyId, {
      name: "Hermes Gateway",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: "https://hermes.example",
        apiKey: literalApiKey,
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const persistedRows = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    const persistedConfig = persistedRows[0]?.adapterConfig as Record<string, unknown>;
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
    expect(persistedConfig.apiKey).toMatchObject({
      type: "secret_ref",
      version: "latest",
    });

    const secretId = (persistedConfig.apiKey as { secretId: string }).secretId;
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId,
      configPath: "apiKey",
      versionSelector: "latest",
      required: true,
    });

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      persistedConfig,
      {
        consumerType: "agent",
        consumerId: created.id,
      },
      { adapterType: "hermes_gateway" },
    );
    expect(resolved.config.apiKey).toBe(literalApiKey);
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
  });

  it("keeps stored agent secret bindings when adapterConfig env changes", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const oldSecret = await secrets.create(companyId, {
      name: `old-${randomUUID()}`,
      provider: "local_encrypted",
      value: "old-value",
    });
    const nextSecret = await secrets.create(companyId, {
      name: `next-${randomUUID()}`,
      provider: "local_encrypted",
      value: "next-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Binding Swapper",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OLD_KEY: { type: "secret_ref", secretId: oldSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(created.id, {
      adapterConfig: {
        env: {
          NEW_KEY: { type: "secret_ref", secretId: nextSecret.id, version: "latest" },
        },
      },
    });

    // The env map merges per key: a binding the write does not mention keeps
    // its stored value. Replacing the whole map is what destroyed credentials
    // on 2026-10-14 and on 2026-08-28 / 2026-09-25.
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => binding.configPath).sort()).toEqual([
      "env.NEW_KEY",
      "env.OLD_KEY",
    ]);

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: {
        OLD_KEY: { type: "secret_ref", secretId: oldSecret.id, version: "latest" },
        NEW_KEY: { type: "secret_ref", secretId: nextSecret.id, version: "latest" },
      },
    });
  });

  it("keeps every stored binding when a service-level write carries a partial env map", async () => {
    // This is the shape the platform's own built-in agent reconciliation
    // writes: a whole adapterConfig with an env map that mentions only some of
    // the agent's bindings, and no explicit removal request. It is the path
    // that silently dropped the WooCommerce bindings from two agents.
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `storefront-${randomUUID()}`,
      provider: "local_encrypted",
      value: "storefront-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Partial Env Writer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          PLAIN_KEY: { type: "plain", value: "plain-value" },
          SECRET_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(created.id, {
      adapterConfig: {
        env: {
          PLAIN_KEY: { type: "plain", value: "plain-value" },
        },
      },
    });

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: {
        PLAIN_KEY: { type: "plain", value: "plain-value" },
        SECRET_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.SECRET_KEY",
    });
  });

  it("removes a binding only when the update names it", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `removable-${randomUUID()}`,
      provider: "local_encrypted",
      value: "removable-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Binding Remover",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          KEEP_KEY: { type: "plain", value: "keep-value" },
          DROP_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(
      created.id,
      {
        adapterConfig: {
          env: {
            KEEP_KEY: { type: "plain", value: "keep-value" },
          },
        },
      },
      { envUpdate: { removals: ["DROP_KEY"] } },
    );

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: { KEEP_KEY: { type: "plain", value: "keep-value" } },
    });
    const env = (reloaded?.adapterConfig as { env?: Record<string, unknown> })?.env ?? {};
    expect(env.DROP_KEY).toBeUndefined();

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(0);
  });

  it("keeps every stored binding when a service-level write carries no env map at all", async () => {
    // The shape the platform's own built-in agent reconciliation writes when
    // the resolved adapter config carries no environment map: the whole
    // adapter config is replaced. Before the service-layer merge, that
    // replacement dropped every binding the agent had.
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `no-env-map-${randomUUID()}`,
      provider: "local_encrypted",
      value: "no-env-map-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "No Env Map Writer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          SECRET_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(
      created.id,
      { adapterConfig: { model: "gpt-5-codex" } },
      { recordRevision: { source: "built-in-agent:ensure" } },
    );

    const reloaded = await agentService(db).getById(created.id);
    expect((reloaded?.adapterConfig as { env?: Record<string, unknown> })?.env).toMatchObject({
      SECRET_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.SECRET_KEY",
    });
  });

  it("keeps every stored binding when the built-in agent reconciliation writes a partial config", async () => {
    // Regression for the two silent drops on our instance: Reflection Coach
    // (2026-08-28) and Summarizer (2026-09-25), both with revision source
    // `built-in-agent:ensure`. The reconciliation wrote an adapter config
    // whose env map named only some of the agent's bindings, and every other
    // binding - including the managed `secret_ref` ones - was deleted.
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `reconcile-${randomUUID()}`,
      provider: "local_encrypted",
      value: "reconcile-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Reconciled Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          KEPT_KEY: { type: "plain", value: "kept-value" },
          SECRET_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(
      created.id,
      {
        adapterConfig: {
          env: {
            KEPT_KEY: { type: "plain", value: "kept-value" },
          },
        },
      },
      { recordRevision: { source: "built-in-agent:ensure" } },
    );

    const reloaded = await agentService(db).getById(created.id);
    expect((reloaded?.adapterConfig as { env?: Record<string, unknown> })?.env).toMatchObject({
      KEPT_KEY: { type: "plain", value: "kept-value" },
      SECRET_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.SECRET_KEY",
    });
  });

  it("records an explicit service-level removal in the activity log", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `recorded-${randomUUID()}`,
      provider: "local_encrypted",
      value: "recorded-value",
    });

    const created = await agentService(db).create(companyId, {
      name: "Recorded Remover",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          DROP_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(
      created.id,
      { adapterConfig: { env: {} } },
      { envUpdate: { removals: ["DROP_KEY"] } },
    );

    const events = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityId, created.id),
        eq(activityLog.action, "agent.adapter_config_env_removed"),
      ));
    expect(events).toHaveLength(1);
    const details = events[0].details as Record<string, unknown>;
    expect(details.removedKeys).toEqual(["DROP_KEY"]);
    // The record names the binding kind, never its value.
    expect(details.removedBindings).toEqual([{ key: "DROP_KEY", kind: "secret_ref" }]);
    // `removedSecretBindingKeys` is masked by the activity-log redactor: its
    // field name matches the secret-field pattern. The kind in
    // `removedBindings` carries the same information and stays readable.
    expect(JSON.stringify(details)).not.toContain("recorded-value");
  });

  it("backfills missing secret bindings when a legacy pending agent is approved", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `legacy-${randomUUID()}`,
      provider: "local_encrypted",
      value: "legacy-value",
    });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const beforeBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
    expect(beforeBindings).toHaveLength(0);

    const approved = await agentService(db).activatePendingApproval(companyId, agentId);

    expect(approved).toMatchObject({
      activated: true,
      agent: {
        id: agentId,
        status: "idle",
      },
    });

    const afterBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agentId),
      ));

    expect(afterBindings).toHaveLength(1);
    expect(afterBindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
    });
  });

  it("rolls back create when binding sync fails", async () => {
    const companyId = await seedCompany();
    const missingSecretId = randomUUID();

    await expect(
      agentService(db).create(companyId, {
        name: "Broken Create",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          env: {
            ANTHROPIC_API_KEY: { type: "secret_ref", secretId: missingSecretId, version: "latest" },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toBeTruthy();

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("rolls back adapterConfig updates when binding sync fails", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const validSecret = await secrets.create(companyId, {
      name: `valid-${randomUUID()}`,
      provider: "local_encrypted",
      value: "valid-value",
    });
    const created = await agentService(db).create(companyId, {
      name: "Transactional Update",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await expect(
      agentService(db).update(created.id, {
        adapterConfig: {
          env: {
            API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
          },
        },
      }),
    ).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: {
        API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.secretId).toBe(validSecret.id);
  });

  it("keeps pending approval status when activation binding sync fails", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Broken Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    await expect(agentService(db).activatePendingApproval(companyId, agentId)).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(agentId);
    expect(reloaded?.status).toBe("pending_approval");
  });
});

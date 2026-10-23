import express from "express";
import request from "supertest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  companyMemberships,
  agentConfigRevisions,
  companySecretBindings,
  agentInstructionHeads,
  agentInstructionRevisions,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { withoutAgentEnvPatch } from "../services/agent-env-config.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentInstructionHeads);
    await db.delete(agentInstructionRevisions);
    await db.delete(agentConfigRevisions);
    await db.delete(companySecretBindings);
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  async function pendingWithEnv() {
    const companyId = await seedCompany();
    const [agent] = await db.insert(agents).values({ companyId, name: "Pending env", role: "engineer", status: "pending_approval",
      adapterType: "process", adapterConfig: { command: "echo safe", env: { KEEP: { type: "plain", value: "synthetic" } } },
    }).returning();
    return agent!;
  }

  it("accepts a non-env pending configuration noop with stored env omitted", async () => {
    const agent = await pendingWithEnv();
    const service = agentService(db);
    const updated = await service.update(agent.id, { adapterConfig: withoutAgentEnvPatch(agent.adapterConfig) }, {
      recordRevision: { source: "patch", createdByUserId: "synthetic-user" },
    });
    expect(updated!.adapterConfig).toEqual(agent.adapterConfig);
    expect(updated!.status).toBe("pending_approval");
    expect(await db.select().from(agentConfigRevisions)).toEqual([]);
  });

  it("preserves persisted JSON semantics for omitted undefined object properties", async () => {
    const agent = await pendingWithEnv();
    const updated = await agentService(db).update(agent.id, { adapterConfig: {
      ...agent.adapterConfig,
      promptTemplate: undefined,
      env: { KEEP: { type: "plain", value: "synthetic", optional: undefined } },
    } });
    expect(updated!.adapterConfig).toEqual(agent.adapterConfig);
    expect(updated!.status).toBe("pending_approval");
  });

  it.each(["removal", "rotation", "addition", "command"] as const)("still freezes real pending %s changes atomically", async (change) => {
    const agent = await pendingWithEnv();
    const adapterConfig = change === "rotation" ? { command: "echo safe", env: { KEEP: { type: "plain", value: "changed" } } }
      : change === "addition" ? { command: "echo safe", env: { ADDED: { type: "plain", value: "added" } } }
      : { command: change === "command" ? "echo changed" : "echo safe" };
    const before = { agents: await db.select().from(agents), bindings: await db.select().from(companySecretBindings),
      revisions: await db.select().from(agentConfigRevisions), activity: await db.select().from(activityLog) };
    await expect(agentService(db).update(agent.id, { adapterConfig }, {
      envUpdate: { removals: change === "removal" ? ["KEEP"] : [] },
      recordRevision: { source: "patch", createdByUserId: "synthetic-user" },
    })).rejects.toMatchObject({ status: 409, details: { code: "pending_approval_agent_config_frozen", fields: ["adapterConfig"] } });
    expect({ agents: await db.select().from(agents), bindings: await db.select().from(companySecretBindings),
      revisions: await db.select().from(agentConfigRevisions), activity: await db.select().from(activityLog) }).toEqual(before);
  });

  it("returns the committed pending entry-file save when clearing absent legacy prompts", async () => {
    const agent = await pendingWithEnv();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Synthetic editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: agent.companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const home = await mkdtemp(path.join(os.tmpdir(), "pending-entry-intent-"));
    const oldHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    try {
      const root = resolveManagedInstructionsRoot(agent);
      const adapterConfig = { ...agent.adapterConfig, instructionsBundleMode: "managed", instructionsRootPath: root,
        instructionsEntryFile: "AGENTS.md", instructionsFilePath: path.join(root, "AGENTS.md") };
      await db.update(agents).set({ adapterConfig }).where(eq(agents.id, agent.id));
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", userId, companyIds: [agent.companyId], isInstanceAdmin: true, source: "local_implicit" }; next(); });
      app.use("/api", agentRoutes(db)); app.use(errorHandler);
      const response = await request(app).put(`/api/agents/${agent.id}/instructions-bundle/file`)
        .send({ path: "AGENTS.md", content: "# Committed pending entry\n", baseRevisionId: null, clearLegacyPromptTemplate: true });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.content).toBe("# Committed pending entry\n");
      expect(response.body.revision.id).toBeTruthy();
      const current = await agentInstructionRevisionService(db).readCurrent(
        { companyId: agent.companyId, agentId: agent.id }, { type: "board", userId, source: "local_implicit" },
      );
      expect(current!.revision.id).toBe(response.body.revision.id);
      expect(current!.content).toBe(response.body.content);
      expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(response.body.content);
      const stored = await agentService(db).getById(agent.id);
      expect(stored!.adapterConfig).toEqual(adapterConfig);
      expect(stored!.status).toBe("pending_approval");
      expect(await db.select().from(agentConfigRevisions)).toEqual([]);
    } finally {
      if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvc.create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
        appearance: pending.appearance,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "idle",
      appearance: pending.appearance,
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });
});

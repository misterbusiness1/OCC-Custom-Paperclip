import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { retrySourceMatchesWakeScope } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres retry-source scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("persisted heartbeat retry-source scope validation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-source-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(
    companyId = randomUUID(),
    agentId = randomUUID(),
    insertCompany = true,
  ) {
    if (insertCompany) {
      await db.insert(companies).values({
        id: companyId,
        name: `Company ${companyId}`,
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId}`,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertSourceRun(input: {
    companyId: string;
    agentId: string;
    taskKey?: string;
    status?: string;
    livenessState?: string | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      livenessState: input.livenessState === undefined ? "advanced" : input.livenessState,
      contextSnapshot: {
        issueId: input.taskKey ?? "issue-1",
        taskId: input.taskKey ?? "issue-1",
        wakeReason: "issue_assigned",
      },
    });
    return runId;
  }

  async function matches(input: {
    companyId: string;
    agentId: string;
    taskKey?: string | null;
    retryOfRunId?: string;
  }) {
    return retrySourceMatchesWakeScope({
      db,
      companyId: input.companyId,
      agentId: input.agentId,
      taskKey: input.taskKey === undefined ? "issue-1" : input.taskKey,
      contextSnapshot: input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {},
    });
  }

  it("accepts a persisted same-company, same-agent, same-task productive terminal source", async () => {
    const scope = await seedCompanyAndAgent();
    const retryOfRunId = await insertSourceRun(scope);

    await expect(matches({ ...scope, retryOfRunId })).resolves.toBe(true);
  });

  it("fails closed when the persisted source run is missing", async () => {
    const scope = await seedCompanyAndAgent();

    await expect(matches({ ...scope, retryOfRunId: randomUUID() })).resolves.toBe(false);
    await expect(matches(scope)).resolves.toBe(false);
  });

  it("fails closed for a source run owned by a foreign company", async () => {
    const expectedScope = await seedCompanyAndAgent();
    const foreignScope = await seedCompanyAndAgent();
    const retryOfRunId = await insertSourceRun(foreignScope);

    await expect(matches({ ...expectedScope, retryOfRunId })).resolves.toBe(false);
  });

  it("fails closed for a source run owned by a foreign agent", async () => {
    const companyId = randomUUID();
    const expectedScope = await seedCompanyAndAgent(companyId);
    const foreignScope = await seedCompanyAndAgent(companyId, randomUUID(), false);
    const retryOfRunId = await insertSourceRun(foreignScope);

    await expect(matches({ ...expectedScope, retryOfRunId })).resolves.toBe(false);
  });

  it("fails closed for a source run from another issue or task", async () => {
    const scope = await seedCompanyAndAgent();
    const retryOfRunId = await insertSourceRun({ ...scope, taskKey: "issue-2" });

    await expect(matches({ ...scope, retryOfRunId })).resolves.toBe(false);
    await expect(matches({ ...scope, taskKey: null, retryOfRunId })).resolves.toBe(false);
  });

  it("fails closed for an unsuccessful terminal source run", async () => {
    const scope = await seedCompanyAndAgent();
    const retryOfRunId = await insertSourceRun({ ...scope, status: "failed" });

    await expect(matches({ ...scope, retryOfRunId })).resolves.toBe(false);
  });

  it.each([null, "plan_only", "empty_response", "failed"])(
    "fails closed for a succeeded but nonproductive source run (%s)",
    async (livenessState) => {
      const scope = await seedCompanyAndAgent();
      const retryOfRunId = await insertSourceRun({ ...scope, livenessState });

      await expect(matches({ ...scope, retryOfRunId })).resolves.toBe(false);
    },
  );
});

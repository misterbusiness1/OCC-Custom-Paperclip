import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { connectionIntentService } from "../services/connection-intents.ts";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.ts";
import { logger } from "../middleware/logger.ts";

const adapter = vi.hoisted(() => ({
  delivery: "native_mcp" as "native_mcp" | "invocation_context",
  execute: vi.fn(),
}));
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({
    supportsLocalAgentJwt: false,
    runtimeToolDelivery: adapter.delivery,
    execute: adapter.execute,
  })),
}));
import { heartbeatService } from "../services/heartbeat.ts";

describe("runtime connection tools require a task", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const deliveries: Array<{
    runtimeTools: AdapterExecutionContext["runtimeTools"];
    contextTools: unknown;
    mcpConnectionIds: string[];
    validation: "accepted" | "rejected" | "not_advertised";
  }> = [];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-runtime-tool-scope-");
    db = createDb(temporary.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-runtime-tool-test-secret");
    warn = vi.spyOn(logger, "warn");
    adapter.execute.mockImplementation(async (ctx: AdapterExecutionContext) => {
      const tools = ctx.runtimeTools;
      let validation: "accepted" | "rejected" | "not_advertised" = "not_advertised";
      if (tools) {
        const claims = verifyRuntimeToolsToken(tools.bearerToken);
        if (!claims) throw new Error("Runtime capability was not valid");
        try {
          await connectionIntentService(db).validate(claims);
          validation = "accepted";
        } catch {
          validation = "rejected";
        }
      }
      deliveries.push({
        runtimeTools: tools,
        contextTools: ctx.context.paperclipRuntimeTools,
        mcpConnectionIds: (ctx.runtimeMcp?.getServers() ?? []).map((server) => server.connectionId),
        validation,
      });
      // Model a provider finishing its task, so teardown has no follow-up work.
      if (typeof ctx.context.issueId === "string") {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, ctx.context.issueId));
      }
      return { exitCode: 0, signal: null, timedOut: false, summary: "Runtime tool delivery checked." };
    });
  });

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE companies CASCADE`);
    deliveries.length = 0;
    adapter.execute.mockReset();
    warn.mockRestore();
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await temporary?.cleanup(); }, 30_000);

  async function seed(bound: boolean) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = bound ? randomUUID() : null;
    await db.insert(companies).values({
      id: companyId, name: "Runtime tool scope", issuePrefix: `R${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "test-operator",
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "test-operator",
      status: "active", membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    if (issueId) await db.insert(issues).values({
      id: issueId, companyId, title: "Bound task", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "test-operator",
    });
    return { companyId, agentId, issueId };
  }

  async function dispatch(bound: boolean) {
    const fixture = await seed(bound);
    const run = await heartbeat.wakeup(fixture.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "runtime_scope_check",
      manualUserWake: true, requestedByActorType: "user", requestedByActorId: "test-operator",
      contextSnapshot: fixture.issueId ? { issueId: fixture.issueId } : {},
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("succeeded");
    expect(deliveries).toHaveLength(1);
    return deliveries[0]!;
  }

  it.each(["native_mcp", "invocation_context"] as const)(
    "does not advertise task-only tools to an unbound %s run", async (delivery) => {
      adapter.delivery = delivery;
      const actual = await dispatch(false);
      expect(actual.runtimeTools).toBeUndefined();
      expect(actual.contextTools).toBeUndefined();
      expect(actual.mcpConnectionIds).not.toContain("paperclip-runtime-tools");
      expect(actual.validation).toBe("not_advertised");
      expect(warn.mock.calls.some((call) => call.includes("runtime connection tools could not be delivered")))
        .toBe(false);
    },
  );

  it.each(["native_mcp", "invocation_context"] as const)(
    "preserves usable task-bound connection tools for %s delivery", async (delivery) => {
      adapter.delivery = delivery;
      const actual = await dispatch(true);
      expect(actual.runtimeTools).toBeDefined();
      expect(actual.validation).toBe("accepted");
      if (delivery === "native_mcp") {
        expect(actual.mcpConnectionIds).toContain("paperclip-runtime-tools");
        expect(actual.contextTools).toBeUndefined();
      } else {
        expect(actual.contextTools).toBe(actual.runtimeTools);
        expect(actual.mcpConnectionIds).not.toContain("paperclip-runtime-tools");
      }
    },
  );

  it("retains a delivery warning for a bound run with no reachable API URL", async () => {
    adapter.delivery = "native_mcp";
    vi.stubEnv("PAPERCLIP_API_URL", "");
    const actual = await dispatch(true);
    expect(actual.runtimeTools).toBeUndefined();
    expect(warn.mock.calls.some((call) => call.includes("runtime connection tools could not be delivered")))
      .toBe(true);
  });
});

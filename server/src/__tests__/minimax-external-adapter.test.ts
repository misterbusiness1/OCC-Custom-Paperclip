// End-to-end coverage for the in-repo MiniMax external adapter
// (packages/adapters/minimax) through the REAL external-adapter plugin loader:
// adapter-plugins.json -> plugin-loader -> registry -> heartbeat -> cost ledger.
//
// The MiniMax API is never called. A node:http stub on 127.0.0.1 serves
// /chat/completions; a loopback plain-http baseUrl is allowed only together
// with a company-scoped env.MINIMAX_API_KEY, which these tests supply.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, costEvents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const ADAPTER_TYPE = "minimax_local";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const adapterDir = path.resolve(repoRoot, "packages/adapters/minimax");

// PAPERCLIP_HOME must point at the temp dir before any server module that
// reads the adapter plugin store is imported (the registry loads external
// adapters in a module-init IIFE).
const previousPaperclipHome = process.env.PAPERCLIP_HOME;
const previousPaperclipApiUrl = process.env.PAPERCLIP_API_URL;
const previousMiniMaxKey = process.env.MINIMAX_API_KEY;
const paperclipHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-minimax-external-"));
process.env.PAPERCLIP_HOME = paperclipHome;
process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100/api";
delete process.env.MINIMAX_API_KEY;
fs.writeFileSync(
  path.join(paperclipHome, "adapter-plugins.json"),
  JSON.stringify(
    [
      {
        packageName: "@paperclipai/minimax-paperclip-adapter",
        localPath: adapterDir,
        type: ADAPTER_TYPE,
        installedAt: new Date(0).toISOString(),
      },
    ],
    null,
    2,
  ),
);

vi.resetModules();
const registry = await import("../adapters/registry.ts");
const adaptersIndex = await import("../adapters/index.ts");
const pluginLoader = await import("../adapters/plugin-loader.ts");
const { BUILTIN_ADAPTER_TYPES } = await import("../adapters/builtin-adapter-types.ts");
await registry.waitForExternalAdapters();

interface StubRequest {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

const stubRequests: StubRequest[] = [];
let stubServer: http.Server;
let stubBaseUrl = "";

const STUB_USAGE = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 };

beforeAll(async () => {
  stubServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      stubRequests.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const isProbe = messages.some(
        (m) => typeof m === "object" && m !== null && String((m as { content?: unknown }).content).includes("Return exactly: OK"),
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-stub",
          object: "chat.completion",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: isProbe ? "OK" : "<think>plan</think>Stub answer from MiniMax." },
            },
          ],
          usage: isProbe ? { prompt_tokens: 5, completion_tokens: 1 } : STUB_USAGE,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => stubServer.listen(0, "127.0.0.1", resolve));
  stubBaseUrl = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  registry.unregisterServerAdapter(ADAPTER_TYPE);
  await new Promise<void>((resolve) => stubServer.close(() => resolve()));
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousPaperclipHome;
  if (previousPaperclipApiUrl === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = previousPaperclipApiUrl;
  if (previousMiniMaxKey !== undefined) process.env.MINIMAX_API_KEY = previousMiniMaxKey;
  fs.rmSync(paperclipHome, { recursive: true, force: true });
});

describe("minimax_local external adapter via the real plugin loader", () => {
  it("is registered from adapter-plugins.json as an external (non built-in) adapter", () => {
    expect(BUILTIN_ADAPTER_TYPES.has(ADAPTER_TYPE)).toBe(false);
    const adapter = adaptersIndex.findServerAdapter(ADAPTER_TYPE);
    expect(adapter).not.toBeNull();
    expect(adapter?.type).toBe(ADAPTER_TYPE);
    expect(adapter?.supportsLocalAgentJwt).toBe(true);
    expect(adapter?.supportsInstructionsBundle).toBe(true);
    expect(adapter?.sessionCodec).toBeUndefined();
    expect(adapter?.models?.map((m) => m.id)).toContain("MiniMax-M3");
  });

  it("caches the CommonJS ui-parser source served at /api/adapters/minimax_local/ui-parser.js", () => {
    const source = pluginLoader.getUiParserSource(ADAPTER_TYPE);
    expect(source).toBeTruthy();
    expect(source).toContain("module.exports");
    expect(source).not.toMatch(/^\s*export\s/m);
  });

  it("exposes the schema-driven config fields", async () => {
    const schema = await adaptersIndex.findServerAdapter(ADAPTER_TYPE)!.getConfigSchema!();
    expect(schema.fields.map((f) => f.key)).toContain("toolsEnabled");
  });

  it("runs testEnvironment against the loopback stub with a company key", async () => {
    const before = stubRequests.length;
    const result = await adaptersIndex.findServerAdapter(ADAPTER_TYPE)!.testEnvironment({
      companyId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      config: { baseUrl: stubBaseUrl, env: { MINIMAX_API_KEY: "probe-key" } },
    });
    expect(result.status).toBe("pass");
    const probe = stubRequests.at(-1)!;
    expect(stubRequests.length).toBe(before + 1);
    expect(probe.authorization).toBe("Bearer probe-key");
    expect(probe.body.model).toBe("MiniMax-M3");
  });

  it("refuses the loopback stub in testEnvironment when only a host key exists", async () => {
    const before = stubRequests.length;
    process.env.MINIMAX_API_KEY = "host-key";
    try {
      const result = await adaptersIndex.findServerAdapter(ADAPTER_TYPE)!.testEnvironment({
        companyId: randomUUID(),
        adapterType: ADAPTER_TYPE,
        config: { baseUrl: stubBaseUrl },
      });
      expect(result.status).toBe("fail");
      expect(result.checks.some((c) => c.code === "minimax_base_url")).toBe(true);
      expect(stubRequests.length).toBe(before);
    } finally {
      delete process.env.MINIMAX_API_KEY;
    }
  });
});

describe("POST /api/adapters/install with isLocalPath (real loader, no mocks)", () => {
  it("loads the package from its directory and reports minimax_local", async () => {
    const { adapterRoutes } = await import("../routes/adapters.ts");
    const { errorHandler } = await import("../middleware/index.ts");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: Record<string, unknown> }).actor = {
        type: "board",
        userId: "local-board",
        companyIds: [],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", adapterRoutes());
    app.use(errorHandler);

    const res = await request(app)
      .post("/api/adapters/install")
      .send({ packageName: adapterDir, isLocalPath: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.type).toBe(ADAPTER_TYPE);
    expect(adaptersIndex.findServerAdapter(ADAPTER_TYPE)?.type).toBe(ADAPTER_TYPE);
    const stored = JSON.parse(fs.readFileSync(path.join(paperclipHome, "adapter-plugins.json"), "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(stored.filter((r) => r.type === ADAPTER_TYPE)).toHaveLength(1);
    expect(stored.find((r) => r.type === ADAPTER_TYPE)?.localPath).toBe(adapterDir);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres minimax external adapter heartbeat test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("minimax_local heartbeat run through the external loader", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("minimax-external-adapter-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (db) {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "activity_log",
          "cost_events",
          "heartbeat_run_events",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
    }
    await tempDb?.cleanup();
  });

  it("succeeds, sends the company key and model to the stub, and ledgers metered_api cost", async () => {
    const { heartbeatService } = await import("../services/heartbeat.ts");
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "MiniMax External",
      issuePrefix: `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "MiniMax Agent",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER_TYPE,
      adapterConfig: {
        baseUrl: stubBaseUrl,
        env: { MINIMAX_API_KEY: "test-key" },
        toolsEnabled: false,
        // A non-default template keeps the contentless-wake no-op from
        // short-circuiting this on-demand run.
        promptTemplate: "You are {{agent.name}}. Reply with a short status line.",
      },
      runtimeConfig: {},
      permissions: {},
    });

    const before = stubRequests.length;
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();

    const deadline = Date.now() + 20_000;
    let run = await heartbeat.getRun(queued!.id);
    while (run && ["queued", "running"].includes(run.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      run = await heartbeat.getRun(queued!.id);
    }

    expect(run?.status, JSON.stringify({ error: run?.error, errorCode: run?.errorCode })).toBe("succeeded");

    const chatRequests = stubRequests.slice(before);
    expect(chatRequests).toHaveLength(1);
    expect(chatRequests[0]!.url).toBe("/v1/chat/completions");
    expect(chatRequests[0]!.authorization).toBe("Bearer test-key");
    expect(chatRequests[0]!.body.model).toBe("MiniMax-M3");
    expect(chatRequests[0]!.body.tools).toBeUndefined();
    const prompt = JSON.stringify(chatRequests[0]!.body.messages);
    expect(prompt).toContain("You are MiniMax Agent.");

    // The heartbeat marks the run succeeded before updateRuntimeState writes
    // the cost event, so poll briefly for the ledger row instead of racing it.
    let ledger = await db.select().from(costEvents).where(eq(costEvents.agentId, agentId));
    const ledgerDeadline = Date.now() + 10_000;
    while (ledger.length === 0 && Date.now() < ledgerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ledger = await db.select().from(costEvents).where(eq(costEvents.agentId, agentId));
    }
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      companyId,
      heartbeatRunId: queued!.id,
      provider: "minimax",
      biller: "minimax",
      billingType: "metered_api",
      costStatus: "reported",
      model: "MiniMax-M3",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      // Default ESTIMATE card for MiniMax-M3: $0.30 in + $1.20 out per 1M tokens.
      costCents: 150,
    });
  }, 40_000);
});

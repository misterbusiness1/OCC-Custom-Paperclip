import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";

const mocks = vi.hoisted(() => ({ validate: vi.fn(), judge: vi.fn() }));
vi.mock("../services/connection-intents.js", () => ({
  connectionIntentService: () => ({ validate: mocks.validate, search: vi.fn(), request: vi.fn() }),
}));
vi.mock("../services/typesafe-runtime-tool.js", async () => {
  const actual = await vi.importActual<typeof import("../services/typesafe-runtime-tool.js")>("../services/typesafe-runtime-tool.js");
  return { ...actual, typeSafeRuntimeToolService: () => ({ judge: mocks.judge }) };
});
import { runtimeConnectionIntentRoutes } from "./connection-intents.js";

describe("TypeSafe runtime MCP route", () => {
  beforeEach(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "typesafe-route-test-secret");
    mocks.validate.mockResolvedValue(undefined);
    mocks.judge.mockResolvedValue({ ok: true, model: "jev-test", answers: {}, rendered: "" });
  });

  function bearer() {
    const minted = createRuntimeToolsToken({ agentId: "agent-a", companyId: "company-a", runId: "run-a", responsibleUserId: "user-a" });
    if (!minted) throw new Error("token unavailable");
    return `Bearer ${minted.token}`;
  }

  it("discovers and executes the tool through the authenticated MCP route", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const listed = await request(app).post("/mcp/runtime-tools").set("authorization", bearer()).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toContain("typesafe_judge");

    const args = { state: "synthetic", model: "jev-latest", questions: { check: { type: "noul", instructions: "Does it apply?" } } };
    const called = await request(app).post("/mcp/runtime-tools").set("authorization", bearer()).send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "typesafe_judge", arguments: args } });
    expect(called.status).toBe(200);
    expect(called.body.result.structuredContent).toMatchObject({ ok: true, model: "jev-test" });
    expect(mocks.judge).toHaveBeenCalledWith(expect.objectContaining({ sub: "agent-a", company_id: "company-a", run_id: "run-a" }), args);
  });
});

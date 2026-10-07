import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";

const mocks = vi.hoisted(() => ({ validate: vi.fn(), judge: vi.fn(), search: vi.fn(), request: vi.fn() }));
vi.mock("../services/connection-intents.js", () => ({
  connectionIntentService: () => ({ validate: mocks.validate, search: mocks.search, request: mocks.request }),
}));
vi.mock("../services/typesafe-runtime-tool.js", async () => {
  const actual = await vi.importActual<typeof import("../services/typesafe-runtime-tool.js")>("../services/typesafe-runtime-tool.js");
  return { ...actual, typeSafeRuntimeToolService: () => ({ judge: mocks.judge }) };
});
import { runtimeConnectionIntentRoutes } from "./connection-intents.js";
import { HttpError } from "../errors.js";

describe("TypeSafe runtime REST/MCP routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "typesafe-route-test-secret");
    vi.stubEnv("PAPERCLIP_TYPESAFE_TOOL_ENABLED", "true");
    mocks.validate.mockResolvedValue(undefined);
    mocks.judge.mockResolvedValue({ ok: true, model: "jev-test", answers: {}, rendered: "" });
  });

  function bearer() {
    const minted = createRuntimeToolsToken({ agentId: "agent-a", companyId: "company-a", runId: "run-a", responsibleUserId: "user-a" });
    if (!minted) throw new Error("token unavailable");
    return `Bearer ${minted.token}`;
  }

  it("answers the SSE stream probe with 405 so a Streamable HTTP client stops reconnecting", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const probed = await request(app).get("/mcp/runtime-tools").set("authorization", bearer());
    expect(probed.status).toBe(405);
    expect(probed.headers.allow).toBe("POST");
    expect(probed.text).toBe("");
    // The probe is still a token use: the bound run is validated first.
    expect(mocks.validate).toHaveBeenCalledTimes(1);
  });

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

  it("returns malformed tool arguments as a tool result the agent can correct", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const args = { state: "synthetic", model: "jev-latest", questions: { rating: { type: "score", instructions: "How severe is it?", criteria: ["only one level"] } } };
    const called = await request(app).post("/mcp/runtime-tools").set("authorization", bearer()).send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "typesafe_judge", arguments: args } });

    // 200 with isError keeps the MCP session alive and shows the agent why.
    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBe(true);
    expect(called.body.result.structuredContent).toMatchObject({ ok: false, error: { code: "invalid_input", retryable: false } });
    expect(called.body.result.structuredContent.error.issues[0].path).toBe("questions.rating.criteria");
    expect(called.body.result.structuredContent.error.hint).toContain("criteria is JSON, never text");
    expect(JSON.stringify(called.body)).not.toContain("only one level");
    expect(mocks.judge).not.toHaveBeenCalled();
  });

  it("names one correctable issue per path for the mistakes real agents made", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const call = async (questions: Record<string, unknown>) => (await request(app).post("/mcp/runtime-tools").set("authorization", bearer())
      .send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "typesafe_judge", arguments: { state: "synthetic", model: "jev-latest", questions } } }))
      .body.result.structuredContent.error.issues as Array<{ path: string; message: string }>;

    // Prose where a Score needs an array: Zod adds a follow-on "string too
    // long" check from the level limit. Reporting it would send the agent
    // off to shorten its text.
    const prose = await call({ sev: { type: "score", instructions: "How severe?", criteria: "the customer is furious and wants a refund" } });
    expect(prose).toEqual([{ path: "questions.sev.criteria", message: expect.stringContaining("expected array") }]);

    const oneOption = await call({ pick: { type: "choice", instructions: "Which?", criteria: { only: "the single option" } } });
    expect(oneOption).toEqual([{ path: "questions.pick.criteria", message: "A choice needs 2 to 255 options" }]);

    const badId = await call({ "1 bad id": { type: "noul", instructions: "Does it apply?" } });
    expect(badId).toHaveLength(1);
    expect(badId[0]?.message).toContain("A question ID starts with a letter");

    // A Choice option ID is a record key too. It has its own, looser rule.
    const badOption = await call({ pick: { type: "choice", instructions: "Which?", criteria: { "": "an empty option ID", other: "the other option" } } });
    expect(badOption).toEqual([{ path: "questions.pick.criteria.", message: "A choice option ID holds 1 to 128 characters." }]);

    const tooMany = await call(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`q${index}`, { type: "noul", instructions: "Does it apply?" }])));
    expect(tooMany).toEqual([{ path: "questions", message: "Send 1 to 32 questions" }]);
    expect(mocks.judge).not.toHaveBeenCalled();
  });

  it("says disabled, not how to fix the input, when the tool is switched off", async () => {
    vi.stubEnv("PAPERCLIP_TYPESAFE_TOOL_ENABLED", "false");
    mocks.judge.mockResolvedValue({ ok: false, error: { code: "disabled", retryable: false } });
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const malformed = { state: "synthetic", model: "jev-latest", questions: { sev: { type: "score", instructions: "How severe?", criteria: "prose" } } };
    const called = await request(app).post("/mcp/runtime-tools").set("authorization", bearer())
      .send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "typesafe_judge", arguments: malformed } });

    // The service owns the switch and answers before it reads the input.
    expect(called.status).toBe(200);
    expect(called.body.result.isError).toBe(true);
    expect(called.body.result.structuredContent).toEqual({ ok: false, error: { code: "disabled", retryable: false } });
    expect(mocks.judge).toHaveBeenCalledWith(expect.objectContaining({ run_id: "run-a" }), malformed);
  });

  it("returns ordinary connection-tool outcomes as tool results, and authority failures as HTTP errors", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const call = (name: string, args: unknown) => request(app).post("/mcp/runtime-tools").set("authorization", bearer())
      .send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

    // An unavailable service, an unknown slug, a declined request: the agent
    // must read these. An HTTP error status would look like a dead transport.
    mocks.request.mockRejectedValueOnce(new HttpError(422, "That service is not available for this workspace"));
    const unavailable = await call("connection_request", { service: "example" });
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.result.isError).toBe(true);
    expect(unavailable.body.result.structuredContent).toEqual({ error: "That service is not available for this workspace", status: 422 });

    const badArgs = await call("connection_request", { service: 42 });
    expect(badArgs.status).toBe(200);
    expect(badArgs.body.result.isError).toBe(true);
    expect(badArgs.body.result.structuredContent).toMatchObject({ error: "Invalid arguments", status: 400 });
    expect(JSON.stringify(badArgs.body)).not.toContain("42,");

    mocks.search.mockResolvedValueOnce({ matches: [] });
    const found = await call("connections_search", { query: "calendar" });
    expect(found.status).toBe(200);
    expect(found.body.result.isError).toBeUndefined();
    expect(found.body.result.structuredContent).toEqual({ matches: [] });

    // Lost authority is not the agent's to work around.
    mocks.search.mockRejectedValueOnce(new HttpError(403, "The run no longer has authority"));
    const forbidden = await call("connections_search", { query: "calendar" });
    expect(forbidden.status).toBe(403);

    // A task reassigned between the route's check and the service's own reload
    // surfaces as a 409 from the service. It is still lost authority.
    mocks.validate.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HttpError(409, "The requesting agent no longer owns this task"));
    mocks.request.mockRejectedValueOnce(new HttpError(409, "The requesting agent no longer owns this task"));
    const raced = await call("connection_request", { service: "example" });
    expect(raced.status).toBe(409);
    expect(raced.body.result).toBeUndefined();
  });

  it("answers a body that is not one JSON-RPC request with 400, never 500", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const post = () => request(app).post("/mcp/runtime-tools").set("authorization", bearer());

    const noBody = await post();
    const text = await post().set("content-type", "text/plain").send("ping");
    const batch = await post().send([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    const objectMethod = await post().send({ jsonrpc: "2.0", id: 1, method: { toString: 1 } });
    for (const response of [noBody, text, batch, objectMethod]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(-32600);
    }

    // Only a JSON-RPC id (a number or a short string) is echoed back.
    const objectId = await post().send({ jsonrpc: "2.0", id: { big: "x".repeat(5000) }, method: "ping" });
    expect(objectId.body).toEqual({ jsonrpc: "2.0", id: null, result: {} });
    const longId = await post().send({ jsonrpc: "2.0", id: "x".repeat(5000), method: "ping" });
    expect(longId.body.id).toBeNull();
  });

  it("keeps HTTP 400 for malformed input on the REST endpoint", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    app.use((err: { name?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.name === "ZodError" ? 400 : 500).json({ error: err.name });
    });
    const called = await request(app).post("/runtime-tools/typesafe/judge").set("authorization", bearer())
      .send({ state: "synthetic", model: "jev-latest", questions: { sev: { type: "score", instructions: "How severe?", criteria: "prose" } } });

    expect(called.status).toBe(400);
    expect(mocks.judge).not.toHaveBeenCalled();
  });

  it("treats a null Noul criteria as omitted", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const args = { state: "synthetic", model: "jev-latest", questions: { check: { type: "noul", instructions: "Does it apply?", criteria: null } } };
    const called = await request(app).post("/mcp/runtime-tools").set("authorization", bearer()).send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "typesafe_judge", arguments: args } });

    expect(called.status).toBe(200);
    expect(called.body.result.structuredContent).toMatchObject({ ok: true });
    const forwarded = mocks.judge.mock.calls[0]?.[1] as { questions: { check: Record<string, unknown> } };
    expect(forwarded.questions.check).toEqual({ type: "noul", instructions: "Does it apply?" });
  });

  it("answers ping and accepts notifications so a client keeps its session", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const ping = await request(app).post("/mcp/runtime-tools").set("authorization", bearer()).send({ jsonrpc: "2.0", id: 6, method: "ping" });
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ jsonrpc: "2.0", id: 6, result: {} });

    const cancelled = await request(app).post("/mcp/runtime-tools").set("authorization", bearer()).send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    expect(cancelled.status).toBe(202);
    expect(cancelled.text).toBe("");
    // Both are still token uses bound to a live run.
    expect(mocks.validate).toHaveBeenCalledTimes(2);
  });

  it("executes the same typed invocation through REST", async () => {
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const args = { state: "synthetic", model: "jev-latest", questions: { check: { type: "noul", instructions: "Does it apply?" } } };
    const called = await request(app).post("/runtime-tools/typesafe/judge").set("authorization", bearer()).send(args);

    expect(called.status).toBe(200);
    expect(called.body).toMatchObject({ ok: true, model: "jev-test" });
    expect(mocks.judge).toHaveBeenCalledWith(expect.objectContaining({ sub: "agent-a", company_id: "company-a", run_id: "run-a" }), args);
  });

  it("does not invoke TypeSafe when MCP live-run validation fails", async () => {
    mocks.validate.mockRejectedValueOnce(Object.assign(new Error("inactive"), { status: 403 }));
    const app = express().use(express.json()).use(runtimeConnectionIntentRoutes(null as never));
    const called = await request(app).post("/mcp/runtime-tools").set("authorization", bearer()).send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "typesafe_judge", arguments: {} } });

    expect(called.status).toBe(403);
    expect(mocks.judge).not.toHaveBeenCalled();
  });
});

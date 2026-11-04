import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

// All fetch calls are mocked: these tests never reach the real MiniMax API.

// A minimal wake that carries an issue, so normalizePaperclipWakePayload is
// non-null and the contentless-wake short-circuit does NOT fire.
const ACTIONABLE_WAKE = { issue: { id: "ISS-1", identifier: "ISS-1", title: "Test task" } };

function makeCtx(
  config: Record<string, unknown>,
  logs: Array<{ stream: string; chunk: string }> = [],
  context: Record<string, unknown> = { paperclipWake: ACTIONABLE_WAKE },
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "MiniMax", adapterType: "minimax_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context,
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
  } as unknown as AdapterExecutionContext;
}

function jsonResponse(
  body: Record<string, unknown>,
  init: { ok?: boolean; status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? (init.ok === false ? 500 : 200),
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("minimax_local execute", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY_FILE;
    delete process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS;
    delete process.env.MINIMAX_LOCAL_PRICING_JSON;
    delete process.env.MINIMAX_LOCAL_TOOLS_ENABLED;
  });

  it("strips think blocks, reports per-run metered usage, and computes a non-zero cost", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [{ finish_reason: "stop", message: { content: "<think>hidden</think>\nVisible answer" } }],
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }),
    );

    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "test-key" } }, logs));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Visible answer");
    expect(result.model).toBe("MiniMax-M3");
    expect(result.provider).toBe("minimax");
    expect(result.biller).toBe("minimax");
    expect(result.billingType).toBe("metered_api");
    expect(result.usageBasis).toBe("per_run");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, cachedInputTokens: 0 });
    // Default estimate card for MiniMax-M3: 0.3 in / 1.2 out per 1M tokens.
    expect(result.costUsd).toBeCloseTo((12 * 0.3 + 7 * 1.2) / 1_000_000, 12);
    expect(logs).toEqual([{ stream: "stdout", chunk: "Visible answer\n" }]);
  });

  it.each([
    { choices: [] },
    { choices: [{ message: { content: [{}] } }] },
    { base_resp: { status_code: 1002, status_msg: "provider failure" } },
  ])("retains reported billable usage when HTTP 200 fails protocol validation: %j", async (payload) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      ...payload,
      usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 2 } },
    }));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "test-key" } }));
    expect(result.exitCode).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, cachedInputTokens: 2 });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("bounds malformed-completion usage before it reaches accounting", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      choices: [], usage: { prompt_tokens: 1e100, completion_tokens: 1e100, cached_tokens: 1e100 },
    }));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "test-key" } }));
    expect(result.exitCode).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 10_000_000, outputTokens: 10_000_000, cachedInputTokens: 10_000_000 });
  });

  it("sends a chat-only request by default (tools are opt-in)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: {} }),
    );
    await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.minimax.io/v1/chat/completions");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe("MiniMax-M3");
    expect(body.tools).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
  });

  it("reads cached tokens from prompt_tokens_details.cached_tokens and prices them at the cached rate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 2000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 1800 } },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 50, cachedInputTokens: 1800 });
    expect(result.costUsd).toBeCloseTo((200 * 0.3 + 1800 * 0.03 + 50 * 1.2) / 1_000_000, 12);
  });

  it("uses a configured pricing override instead of the estimate card", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    );
    const result = await execute(
      makeCtx({
        env: { MINIMAX_API_KEY: "k" },
        pricing: { "MiniMax-M3": { inputPerMTok: 1, outputPerMTok: 2 } },
      }),
    );
    expect(result.costUsd).toBeCloseTo(3, 9);
  });

  it("uses MINIMAX_LOCAL_PRICING_JSON when no per-agent pricing is set", async () => {
    process.env.MINIMAX_LOCAL_PRICING_JSON = JSON.stringify({ "MiniMax-M3": { inputPerMTok: 4, outputPerMTok: 1 } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 500_000, completion_tokens: 10 },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.costUsd).toBeCloseTo(2.00001, 9);
  });

  it("leaves costUsd undefined for an unknown model so the ledger records it as unpriced", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" }, model: "MiniMax-Future-9" }));
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("MiniMax-Future-9");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
    expect(result.costUsd).toBeUndefined();
    expect("costUsd" in result).toBe(false);
  });

  it("normalizes hand-typed model ids to the canonical MiniMax id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: {} }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" }, model: "vendor/minimax-m2.7-HIGHSPEED" }));
    expect(result.model).toBe("MiniMax-M2.7-highspeed");
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.model).toBe("MiniMax-M2.7-highspeed");
  });

  it("lets primaryModel override model (the environment probe resolves the same way)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: {} }),
    );
    const result = await execute(
      makeCtx({ env: { MINIMAX_API_KEY: "k" }, primaryModel: "MiniMax-M2.7-highspeed", model: "MiniMax-M3" }),
    );
    expect(result.model).toBe("MiniMax-M2.7-highspeed");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body)).model).toBe("MiniMax-M2.7-highspeed");
    expect(init.redirect).toBe("manual");
  });

  it("returns a non-transient structured error on HTTP 402", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { type: "insufficient_balance_error", message: "Insufficient balance" } }, { ok: false, status: 402 }),
    );
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }, logs));

    expect(result.exitCode).toBe(1);
    expect(result.errorMeta).toMatchObject({ httpStatus: 402 });
    expect(result.errorCode).toBe("http_402");
    expect(result.errorMessage).toBe("Insufficient balance");
    expect(result.errorFamily).toBeNull();
    expect(logs[0]).toEqual({ stream: "stderr", chunk: "Insufficient balance\n" });
  });

  it("classifies HTTP 429 as provider_quota", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "rate limited" } }, { ok: false, status: 429 }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(1);
    expect(result.errorMeta).toMatchObject({ httpStatus: 429 });
    expect(result.errorCode).toBe("http_429");
    expect(result.errorFamily).toBe("provider_quota");
  });

  it.each([500, 503])("classifies HTTP %i as transient_upstream", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: `err ${status}` } }, { ok: false, status }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("classifies a fetch/connection rejection as transient_upstream", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toContain("MiniMax request failed");
  });

  it("returns timedOut on an aborted request", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" }, requestTimeoutSec: 1 }));
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("minimax_request_timeout");
    expect(result.errorMessage).toContain("timed out");
  });

  it("fails when the API returns 200 with an empty completion payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("minimax_empty_completion");
    expect(result.errorMessage).toContain("empty completion payload");
    expect((result.errorMeta as Record<string, unknown> | undefined)?.protocolError).toBe("empty_completion_payload");
  });

  it("fails when the API returns 200 with a non-JSON body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    } as unknown as Response);
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("minimax_empty_completion");
  });

  it.each([{}, null, [], { message: null }, { message: [] }, { message: {} },
    { message: { role: "user", content: "hi" } }, { message: { content: 42 } },
    { message: { content: "hi", tool_calls: {} } },
    { message: { content: [{}] } }, { message: { content: [42] } },
    { message: { content: [{ text: 42 }] } },
    { message: { content: [{ type: "image", text: "unsupported" }] } },
    { message: { content: null, tool_calls: [{}] } },
    { message: { content: null, tool_calls: [null] } },
    { message: { content: null, tool_calls: ["bash"] } },
    { message: { tool_calls: [{ function: { name: "bash" } }] } }])("rejects malformed selected completion %j", async (choice) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ choices: [choice] }));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("minimax_invalid_completion");
    expect(result.errorMeta).toMatchObject({ protocolError: "invalid_assistant_message" });
  });

  it.each([{ content: "" }, { content: null }, { content: [] },
    { content: [{ type: "text", text: "" }] }])("retains valid explicit blank content %j as empty-output no-op", async ({ content }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 5 },
    }));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({ stopReason: "empty_output" });
    expect(result.usage?.inputTokens).toBe(5);
  });

  it("accepts supported array-of-text-parts completion content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      choices: [{ message: { content: [{ type: "text", text: "Hello" }, { text: " world" }] } }],
    }));
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Hello world");
  });

  it("treats a blank final answer as a no-op (exit 0) and still records usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "<think>only</think>" } }], usage: { prompt_tokens: 5 } }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(0);
    expect((result.resultJson as Record<string, unknown> | undefined)?.stopReason).toBe("empty_output");
    expect(result.usage?.inputTokens).toBe(5);
  });

  it("no-ops a contentless wake (no issue/comment/handoff) without calling the model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }, logs, {}));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("No actionable task in this wake; standing by.");
    expect((result.resultJson as Record<string, unknown> | undefined)?.stopReason).toBe("contentless_wake");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });

  it("does not no-op a contentless wake under a custom prompt template", async () => {
    // A custom template may interpolate {{context.*}} task data the guard can't
    // inspect, so the short-circuit must stay disabled and the model still runs.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "hi" } }], usage: { prompt_tokens: 1 } }),
    );
    const result = await execute(
      makeCtx({ env: { MINIMAX_API_KEY: "k" }, promptTemplate: "Custom: {{agent.id}}" }, [], {}),
    );
    expect(fetchSpy).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hi");
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.messages[0].content).toContain("Custom: agent-1");
  });

  it("refuses to send the host key to a custom baseUrl (exfiltration guard)", async () => {
    process.env.MINIMAX_API_KEY = "host-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await execute(makeCtx({ baseUrl: "https://attacker.example/v1" }));

    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("minimax_base_url");
    expect(result.errorMessage).toContain("Refusing to send the shared host MiniMax API key");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the host key for the default endpoint", async () => {
    process.env.MINIMAX_API_KEY = "host-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "hi" } }], usage: {} }),
    );
    const result = await execute(makeCtx({}));
    expect(result.exitCode).toBe(0);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer host-key" });
  });

  it("allows a custom https baseUrl when the company supplies its own key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "hi" } }], usage: {} }),
    );
    const result = await execute(makeCtx({ baseUrl: "https://proxy.example/v1/", env: { MINIMAX_API_KEY: "company-key" } }));

    expect(result.exitCode).toBe(0);
    expect(fetchSpy).toHaveBeenCalledWith("https://proxy.example/v1/chat/completions", expect.anything());
  });

  it("rejects a non-https custom baseUrl", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await execute(makeCtx({ baseUrl: "http://proxy.example/v1", env: { MINIMAX_API_KEY: "company-key" } }));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorMessage).toContain("https");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows a plain-http loopback baseUrl only with a company key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "hi" } }], usage: {} }),
    );
    const ok = await execute(makeCtx({ baseUrl: "http://127.0.0.1:9999/v1", env: { MINIMAX_API_KEY: "company-key" } }));
    expect(ok.exitCode).toBe(0);
    expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:9999/v1/chat/completions", expect.anything());

    fetchSpy.mockClear();
    process.env.MINIMAX_API_KEY = "host-key";
    const refused = await execute(makeCtx({ baseUrl: "http://127.0.0.1:9999/v1" }));
    expect(refused.exitCode).not.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS for custom endpoints", async () => {
    process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS = "allowed.example";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await execute(makeCtx({ baseUrl: "https://other.example/v1", env: { MINIMAX_API_KEY: "company-key" } }));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorMessage).toContain("not permitted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails cleanly when no credential is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await execute(makeCtx({}));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorCode).toBe("minimax_credentials");
    expect((result.errorMeta as Record<string, unknown> | undefined)?.code).toBe("minimax_credentials");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores a tenant-supplied MINIMAX_API_KEY_FILE in adapter env", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY_FILE: "/etc/hostname" } }));
    expect(result.errorCode).toBe("minimax_credentials");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails with minimax_run_budget when the run budget is already exhausted", async () => {
    // The first completion returns at once; the tool command then outlives the
    // 1s run budget, so the budget check before the next request fails the run.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return jsonResponse({
        choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c", function: { name: "bash", arguments: "{\"command\":\"sleep 2\"}" } }] } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    });
    const result = await execute(
      makeCtx({ env: { MINIMAX_API_KEY: "k" }, toolsEnabled: true, timeoutSec: 1, cwd: "/tmp" }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("minimax_run_budget");
    expect(result.usage?.inputTokens).toBe(3);
  });
});

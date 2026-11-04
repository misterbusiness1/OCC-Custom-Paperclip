import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { MINIMAX_LOCAL_MAX_FINAL_TEXT_CHARS, MINIMAX_LOCAL_MAX_RESPONSE_BYTES } from "../constants.js";
import { testEnvironment } from "./test.js";

// No test here reaches the real MiniMax API: fetch is mocked, or pointed at a
// node:http stub bound to 127.0.0.1.

const ACTIONABLE_WAKE = { issue: { id: "ISS-1", identifier: "ISS-1", title: "Test task" } };

function makeCtx(
  config: Record<string, unknown>,
  logs: Array<{ stream: string; chunk: string }> = [],
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "MiniMax", adapterType: "minimax_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: { paperclipWake: ACTIONABLE_WAKE },
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
  } as unknown as AdapterExecutionContext;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("minimax_local execute hardening", () => {
  let servers: http.Server[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS;
    delete process.env.MINIMAX_LOCAL_PRICING_JSON;
    delete process.env.MINIMAX_LOCAL_TOOLS_ENABLED;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers = [];
  });

  async function startStub(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  it("times out (instead of hanging) when a real upstream sends headers and then stalls the body", async () => {
    const baseUrl = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":[');
      // never res.end()
    });
    const started = Date.now();
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "test-key" }, baseUrl, requestTimeoutSec: 1 }));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5000);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("minimax_request_timeout");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("times out a stalled body even when the fetch implementation ignores the abort signal", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"choices":['));
        },
      });
      return new Response(stream, { status: 200 });
    });
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" }, requestTimeoutSec: 1 }));
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("minimax_request_timeout");
  });

  it("aborts a response body larger than the cap instead of buffering it", async () => {
    const chunk = "x".repeat(1024 * 1024);
    const baseUrl = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":[{"message":{"content":"');
      let sent = 0;
      const pump = () => {
        while (sent < MINIMAX_LOCAL_MAX_RESPONSE_BYTES + 4 * chunk.length) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end('"}}]}');
      };
      pump();
    });
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "test-key" }, baseUrl }, logs));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("minimax_response_too_large");
    expect(result.summary ?? "").toBe("");
    const logged = logs.reduce((n, l) => n + l.chunk.length, 0);
    expect(logged).toBeLessThan(100_000);
  });

  it("caps the final assistant text used for the summary and log", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "y".repeat(500_000) } }] }),
    );
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }, logs));
    expect(result.exitCode).toBe(0);
    expect(result.summary!.length).toBeLessThan(101_000);
    expect(result.summary).toContain("[output truncated");
    expect(logs.reduce((n, l) => n + l.chunk.length, 0)).toBeLessThan(110_000);
  });

  it("classifies a MiniMax base_resp rate limit on HTTP 200 as provider_quota with the real message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ base_resp: { status_code: 1002, status_msg: "rate limit exceeded(RPM)" } }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("minimax_api_1002");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMessage).toContain("rate limit exceeded(RPM)");
  });

  it("classifies base_resp server errors as transient and auth/balance errors as non-retryable", async () => {
    const cases: Array<[number, string | null]> = [
      [1013, "transient_upstream"],
      [1001, "transient_upstream"],
      [1039, "provider_quota"],
      [1004, null],
      [1008, null],
    ];
    for (const [code, family] of cases) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        jsonResponse({ base_resp: { status_code: code, status_msg: `err ${code}` } }),
      );
      const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
      expect(result.errorCode).toBe(`minimax_api_${code}`);
      expect(result.errorFamily ?? null).toBe(family);
    }
  });

  it("fails a base_resp error even when a choices array is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "" } }],
        base_resp: { status_code: 1002, status_msg: "rate limited" },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.errorCode).toBe("minimax_api_1002");
  });

  it("does not treat base_resp status_code 0 as an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "fine" } }],
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("fine");
  });

  it("honours Retry-After (seconds) on HTTP 429 via retryNotBefore and uses exit code 1", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "120" }),
    );
    const before = Date.now();
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(1);
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.errorMeta).toMatchObject({ httpStatus: 429 });
    expect(result.retryNotBefore).toBeTruthy();
    const at = Date.parse(result.retryNotBefore!);
    expect(at - before).toBeGreaterThanOrEqual(119_000);
    expect(at - before).toBeLessThanOrEqual(125_000);
    expect((result.resultJson as Record<string, unknown>).retryNotBefore).toBe(result.retryNotBefore);
  });

  it("honours an HTTP-date Retry-After on 503 and ignores it on a non-retryable 400", async () => {
    const date = new Date(Date.now() + 60_000).toUTCString();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { message: "busy" } }, 503, { "retry-after": date }),
    );
    const transient = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(transient.errorFamily).toBe("transient_upstream");
    expect(transient.retryNotBefore).toBeTruthy();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: { message: "bad" } }, 400, { "retry-after": "30" }),
    );
    const bad = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(bad.errorFamily ?? null).toBeNull();
    expect(bad.retryNotBefore ?? null).toBeNull();
  });

  it("caps an absurd Retry-After at one hour", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "x" } }, 429, { "retry-after": "99999999" }),
    );
    const before = Date.now();
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    const delay = Date.parse(result.retryNotBefore!) - before;
    expect(delay).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
    expect(delay).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
  });

  it("scrubs the API key from an upstream error message that echoes it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { message: "bad auth header: Bearer sk-company-secret-123" } }, 401),
    );
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "sk-company-secret-123" } }, logs));
    expect(result.errorMessage).not.toContain("sk-company-secret-123");
    expect(logs.map((l) => l.chunk).join("")).not.toContain("sk-company-secret-123");
  });

  it("does not record a negative or zero cost from a tenant pricing override", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      }),
    );
    const result = await execute(
      makeCtx({ env: { MINIMAX_API_KEY: "k" }, pricing: { "MiniMax-M3": { inputPerMTok: -50, outputPerMTok: -50 } } }),
    );
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("bounds hostile usage numbers before they reach the ledger", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1e300, completion_tokens: 1e300 },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.usage!.inputTokens).toBeLessThan(2 ** 31);
    expect(result.usage!.outputTokens).toBeLessThan(2 ** 31);
    expect(Number.isFinite(result.costUsd!)).toBe(true);
    expect(Math.round(result.costUsd! * 100)).toBeLessThan(2 ** 31);
  });

  it("truncates tool output by UTF-8 bytes, not UTF-16 characters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  // 3000 x "é" = 3000 UTF-16 units but 6000 UTF-8 bytes.
                  function: { name: "bash", arguments: JSON.stringify({ command: "printf 'é%.0s' $(seq 1 3000)" }) },
                },
              ],
            },
          },
        ],
      }),
    );
    fetchSpy.mockResolvedValueOnce(jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }));
    const result = await execute(
      makeCtx({ env: { MINIMAX_API_KEY: "k" }, toolsEnabled: true, toolOutputLimitBytes: 4096, cwd: "/tmp" }),
    );
    expect(result.exitCode).toBe(0);
    const secondBody = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body));
    const toolMessage = secondBody.messages.find((m: { role: string }) => m.role === "tool");
    const output = String(toolMessage.content).replace(/^exit code: 0\n/, "").replace(/\n\[output truncated\]$/, "");
    expect(toolMessage.content).toContain("[output truncated]");
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(4096);
    expect(output).not.toContain("�");
  });

  describe("redirects are refused, never followed", () => {
    // R answers 307 to T. T is NOT on the operator allowlist; the guard must
    // not be side-stepped by following the hop.
    async function startRedirectPair() {
      const hits: Array<{ server: "R" | "T"; method?: string; url?: string; auth?: string }> = [];
      const target = await startStub((req, res) => {
        hits.push({ server: "T", method: req.method, url: req.url, auth: req.headers.authorization });
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "INTERNAL SECRET DATA: do-not-leak" } }));
      });
      const targetPort = new URL(target).port;
      const redirector = await startStub((req, res) => {
        hits.push({ server: "R", method: req.method, url: req.url, auth: req.headers.authorization });
        req.resume();
        res.writeHead(307, { location: `http://localhost:${targetPort}/internal-admin` });
        res.end();
      });
      process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS = new URL(redirector).host;
      return { redirector, hits };
    }

    it("execute() fails with minimax_redirect_refused and does not contact the redirect target", async () => {
      const { redirector, hits } = await startRedirectPair();
      const logs: Array<{ stream: string; chunk: string }> = [];
      const result = await execute(
        makeCtx({ env: { MINIMAX_API_KEY: "sk-company" }, baseUrl: redirector }, logs),
      );
      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("minimax_redirect_refused");
      expect(result.errorFamily ?? null).toBeNull();
      expect(result.errorMeta).toMatchObject({ httpStatus: 307 });
      expect(hits.map((h) => h.server)).toEqual(["R"]);
      expect(hits[0]).toMatchObject({ method: "POST", url: "/v1/chat/completions", auth: "Bearer sk-company" });
      const allText = `${result.errorMessage} ${logs.map((l) => l.chunk).join("")}`;
      expect(allText).not.toContain("INTERNAL SECRET DATA");
    });

    it("testEnvironment() fails the probe and does not contact the redirect target", async () => {
      const { redirector, hits } = await startRedirectPair();
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "minimax_local",
        config: { env: { MINIMAX_API_KEY: "sk-company" }, baseUrl: redirector },
      } as never);
      expect(result.status).toBe("fail");
      const completion = result.checks.find((c) => c.code === "minimax_completion");
      expect(completion?.level).toBe("error");
      expect(completion?.message).toMatch(/redirect/);
      expect(JSON.stringify(result)).not.toContain("INTERNAL SECRET DATA");
      expect(hits.map((h) => h.server)).toEqual(["R"]);
    });

    it("execute() also refuses an opaque redirect from a spec-compliant fetch", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        expect((init as RequestInit).redirect).toBe("manual");
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, "type", { value: "opaqueredirect" });
        Object.defineProperty(response, "status", { value: 0 });
        return response;
      });
      const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
      expect(result.errorCode).toBe("minimax_redirect_refused");
    });
  });

  it("scrubs the API key from successful model output (summary, resultJson and run log)", async () => {
    const key = "company-secret-VALUE-123";
    const baseUrl = await startStub((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: `Done. key=${req.headers.authorization}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: key }, baseUrl }, logs));
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Done. key=Bearer ***REDACTED***");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(logs.map((l) => l.chunk).join("")).not.toContain(key);
  });

  it("detects tool-call markup that appears after the final-text length cut", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { content: `${"a".repeat(MINIMAX_LOCAL_MAX_FINAL_TEXT_CHARS + 10)}<tool_call>{"name":"bash"}` },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("minimax_tool_markup");
  });

  it("keeps cached tokens within input tokens and leaves a nonsense usage block unpriced", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: "1e30", completion_tokens: -5, prompt_tokens_details: { cached_tokens: 1e9 } },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(result.costUsd).toBeUndefined();
  });

  it("clamps cached tokens to input tokens in the stored usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5000 } },
      }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 100 });
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("leaves a run unpriced (not $0) when a completion carries no usage block", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
    );
    const result = await execute(makeCtx({ env: { MINIMAX_API_KEY: "k" } }));
    expect(result.exitCode).toBe(0);
    expect(result.billingType).toBe("metered_api");
    expect(result.costUsd).toBeUndefined();
  });

  it("lets the operator's MINIMAX_LOCAL_PRICING_JSON take precedence over a tenant pricing override", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
      }),
    );
    process.env.MINIMAX_LOCAL_PRICING_JSON = JSON.stringify({ "MiniMax-M3": { inputPerMTok: 2, outputPerMTok: 4 } });
    const result = await execute(
      makeCtx({
        env: { MINIMAX_API_KEY: "k" },
        pricing: { "MiniMax-M3": { inputPerMTok: 1e-9, outputPerMTok: 1e-9 } },
      }),
    );
    expect(result.costUsd).toBeCloseTo(2, 9);
  });
});

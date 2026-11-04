import { beforeEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

// fetch is mocked in every case: the environment probe never reaches MiniMax.

function textResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? (init.ok === false ? 500 : 200),
  });
}

describe("minimax_local testEnvironment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY_FILE;
    delete process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS;
  });

  it("fails cleanly when no API key is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await testEnvironment({ companyId: "company-1", adapterType: "minimax_local", config: {} });
    expect(result.status).toBe("fail");
    expect(result.checks[0]?.code).toBe("minimax_credentials");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes when the probe returns OK, sending the company key and model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse({ choices: [{ message: { content: "<think>x</think>OK" } }] }),
    );

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" }, model: "minimax-m2.7" },
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.code === "minimax_completion" && c.level === "info")).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.minimax.io/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String((init as RequestInit).body)).model).toBe("MiniMax-M2.7");
    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  it("probes the same model a run uses: primaryModel overrides model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse({ choices: [{ message: { content: "OK" } }] }),
    );
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" }, primaryModel: "MiniMax-M2.7-highspeed", model: "MiniMax-M3" },
    });
    expect(result.status).toBe("pass");
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body)).model).toBe("MiniMax-M2.7-highspeed");
    expect((init as RequestInit).redirect).toBe("manual");
  });

  it("accepts a { value } env binding shape from the environment-test draft", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse({ choices: [{ message: { content: "OK" } }] }));
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: { type: "plain", value: "draft-key" } } },
    });
    expect(result.status).toBe("pass");
  });

  it("passes with an informational detail when the probe answer is not exactly OK", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse({ choices: [{ message: { content: "Sure! OK then" } }] }));
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" } },
    });
    expect(result.status).toBe("pass");
    expect(result.checks.find((c) => c.code === "minimax_completion")?.detail).toContain("non-OK");
  });

  it("fails on an HTTP error from the probe", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse('{"error":"unauthorized"}', { ok: false, status: 401 }),
    );
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "bad-key" } },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "minimax_completion" && c.level === "error")).toBe(true);
  });

  it("fails on non-JSON output", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("<html>maintenance</html>"));
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" } },
    });
    expect(result.status).toBe("fail");
  });

  it("fails when the probe request throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" } },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.code === "minimax_completion")?.detail).toContain("ECONNREFUSED");
  });

  it("refuses to probe a custom baseUrl with the shared host key (exfiltration guard)", async () => {
    process.env.MINIMAX_API_KEY = "host-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { baseUrl: "https://attacker.example/v1" },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "minimax_base_url")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("never echoes a raw upstream body in the check detail (no loopback read-back)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse("INTERNAL-SECRET-DATA admin_token=abc123", { status: 200 }),
    );
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" }, baseUrl: "http://127.0.0.1:9/v1" },
    });
    expect(result.status).toBe("fail");
    expect(JSON.stringify(result)).not.toContain("INTERNAL-SECRET-DATA");
    expect(JSON.stringify(result)).not.toContain("abc123");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse({ data: "INTERNAL-SECRET-DATA" }, { status: 200 }),
    );
    const json = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" }, baseUrl: "http://127.0.0.1:9/v1" },
    });
    expect(json.status).toBe("fail");
    expect(JSON.stringify(json)).not.toContain("INTERNAL-SECRET-DATA");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse("<html>INTERNAL-SECRET-DATA</html>", { status: 500 }),
    );
    const httpError = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" }, baseUrl: "http://127.0.0.1:9/v1" },
    });
    expect(httpError.status).toBe("fail");
    expect(JSON.stringify(httpError)).not.toContain("INTERNAL-SECRET-DATA");
  });

  it("refuses a baseUrl with a query string (cannot neutralise the /chat/completions suffix)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" }, baseUrl: "http://127.0.0.1:9/secret?x=" },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "minimax_base_url")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces only a redacted structured error message, with the key scrubbed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse({ error: { message: "invalid key sk-probe-secret-9 for Bearer sk-probe-secret-9" } }, { status: 401 }),
    );
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "sk-probe-secret-9" } },
    });
    expect(result.status).toBe("fail");
    const detail = result.checks.find((c) => c.code === "minimax_completion")?.detail ?? "";
    expect(detail).toContain("invalid key");
    expect(detail).not.toContain("sk-probe-secret-9");
  });

  it("redacts the key from a thrown transport error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("proxy said: Bearer sk-probe-secret-9 refused"));
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "sk-probe-secret-9" } },
    });
    expect(JSON.stringify(result)).not.toContain("sk-probe-secret-9");
  });

  it("fails a base_resp error returned as HTTP 200 and shows its status_msg", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      textResponse({ base_resp: { status_code: 1004, status_msg: "authorized error" } }),
    );
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" } },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.code === "minimax_completion")?.detail).toContain("authorized error");
  });

  it("refuses an oversized probe response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(textResponse("z".repeat(1024 * 1024)));
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "minimax_local",
      config: { env: { MINIMAX_API_KEY: "test-key" } },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.find((c) => c.code === "minimax_completion")?.message).toMatch(/exceeded/);
  });
});

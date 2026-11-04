import { beforeEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

// fetch is mocked in every case: the environment probe never reaches MiniMax.

function textResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
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
});

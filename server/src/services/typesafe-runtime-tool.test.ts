import { describe, expect, it, vi } from "vitest";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { renderTypeSafeResult, typeSafeJudgeInputSchema, typeSafeRuntimeToolService, validateTypeSafeAnswers } from "./typesafe-runtime-tool.js";

const input = typeSafeJudgeInputSchema.parse({
  state: { message: "A synthetic non-sensitive test request" }, model: "jev-latest",
  questions: {
    route: { type: "choice", instructions: "Choose a route", criteria: { alpha: "A", no_match: "Neither" } },
    applies: { type: "noul", instructions: "Does it apply?", criteria: { true: "yes", false: "no" } },
    quality: { type: "score", instructions: "Rate quality", criteria: ["low", "medium", "high"] },
  },
});
const answers = {
  route: { type: "choice", choice: "no_match", probabilities: { alpha: 0.4, no_match: 0.6 }, confidence: 0.2, injected: "drop" },
  applies: { type: "noul", noul: 0.51, injected: "drop" },
  quality: { type: "score", score: 1.2, legend: { 0: "low", 1: "medium", 2: "high" }, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.4, injected: "drop" },
};
const payload = { model: "jev-1.13.0", answers, usage: { input_tokens: 123, output_tokens: 45 }, injected: "drop" };
const claims = (runId = "run-fresh", companyId = "company-a"): RuntimeToolsTokenClaims => ({
  sub: "agent-a", company_id: companyId, run_id: runId, responsible_user_id: "user-a", scope: "connection_intents",
  iat: 1, exp: 2, instance_id: "instance-a",
});
const agent = { adapterConfig: { env: { TYPESAFE_API_KEY: { type: "secret_ref", secretId: "secret-a", version: "latest" } } }, updatedAt: new Date("2026-10-03T00:00:00Z") };
function service(overrides: Record<string, unknown> = {}) {
  return typeSafeRuntimeToolService(null as never, {
    env: { PAPERCLIP_TYPESAFE_TOOL_ENABLED: "true" }, now: () => 100,
    validateCapability: vi.fn(async () => undefined),
    loadAgent: vi.fn(async () => agent), loadCatalogRevision: vi.fn(async () => "catalog-a"),
    resolveSecret: vi.fn(async () => ({ value: "test-key", secretVersionId: "version-a" })),
    fetch: vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
    sleep: vi.fn(async () => undefined), ...overrides,
  });
}

describe("TypeSafe runtime tool contract", () => {
  it("reconstructs batched typed answers, strips injected fields, and renders code-owned output", () => {
    const result = validateTypeSafeAnswers(input, payload);
    expect(JSON.stringify(result)).not.toContain("injected");
    expect(result).toMatchObject({ model: "jev-1.13.0", answers: { route: { choice: "no_match" }, applies: { noul: 0.51 }, quality: { score: 1.2 } }, usage: { inputTokens: 123, outputTokens: 45 } });
    expect(renderTypeSafeResult(result)).toBe("route: no_match\napplies: 0.510\nquality: 1.200");
  });

  it.each([
    ["missing score legend", { ...answers, quality: { ...answers.quality, legend: undefined } }],
    ["mismatched score legend", { ...answers, quality: { ...answers.quality, legend: { 0: "low", 1: "wrong", 2: "high" } } }],
    ["non-finite noul", { ...answers, applies: { type: "noul", noul: Number.NaN } }],
    ["unknown choice", { ...answers, route: { ...answers.route, choice: "foreign" } }],
    ["out-of-range score", { ...answers, quality: { ...answers.quality, score: 3 } }],
  ])("rejects %s", (_label, replacement) => {
    expect(() => validateTypeSafeAnswers(input, { ...payload, answers: replacement })).toThrow("invalid_response");
  });

  it("aligns request types with the public API", () => {
    for (const state of [null, true, 2]) expect(() => typeSafeJudgeInputSchema.parse({ state, model: "jev-latest", questions: { q: { type: "noul", instructions: "x" } } })).toThrow();
    expect(() => typeSafeJudgeInputSchema.parse({ state: "x", model: "jev-latest", questions: { q: { type: "score", instructions: "x", criteria: ["ok", 2] } } })).toThrow();
    expect(() => typeSafeJudgeInputSchema.parse({ state: "x", model: "jev-latest", questions: { q: { type: "noul", instructions: "x", criteria: { true: 1 } } } })).toThrow();
  });

  it("calls the documented outbound boundary with only state, model, and questions", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const actual = await service({ fetch }).judge(claims(), input);
    expect(actual).toMatchObject({ ok: true, model: "jev-1.13.0", rendered: "route: no_match\napplies: 0.510\nquality: 1.200", metadata: { catalogRevision: "catalog-a", cached: false } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const requestInit = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(JSON.parse(String(requestInit.body))).toEqual({ state: input.state, model: input.model, questions: input.questions });
  });

  it("rejects invalid live-run authority before credential or provider access", async () => {
    const denied = Object.assign(new Error("Runtime tool token is no longer active"), { status: 403 });
    const validateCapability = vi.fn(async () => { throw denied; });
    const loadAgent = vi.fn(async () => agent);
    const resolveSecret = vi.fn(async () => ({ value: "test-key", secretVersionId: "version-a" }));
    const fetch = vi.fn();
    const runtime = service({ validateCapability, loadAgent, resolveSecret, fetch });

    await expect(runtime.judge(claims(), input)).rejects.toBe(denied);
    expect(validateCapability).toHaveBeenCalledOnce();
    expect(loadAgent).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discards a provider result when live-run authority is lost while pending", async () => {
    const denied = Object.assign(new Error("Runtime tool token is no longer active"), { status: 403 });
    const validateCapability = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(denied);
    const response = new Response(JSON.stringify(payload), { status: 200 });
    const json = vi.spyOn(response, "json");
    const resolveSecret = vi.fn(async () => ({ value: "test-key", secretVersionId: "version-a" }));
    const runtime = service({ validateCapability, resolveSecret, fetch: vi.fn(async () => response) });

    await expect(runtime.judge(claims(), input)).rejects.toBe(denied);
    expect(validateCapability).toHaveBeenCalledTimes(2);
    expect(json).not.toHaveBeenCalled();
    expect(resolveSecret).toHaveBeenCalledOnce();
  });

  it("supports fresh and resumed run claims without allowing identity selection", async () => {
    const loadAgent = vi.fn(async () => agent);
    const resolveSecret = vi.fn(async (_company, _binding, runtimeClaims: RuntimeToolsTokenClaims) => ({ value: "test-key", secretVersionId: `version-${runtimeClaims.run_id}` }));
    const runtime = service({ loadAgent, resolveSecret });
    expect((await runtime.judge(claims("fresh"), input)).ok).toBe(true);
    expect((await runtime.judge(claims("resumed"), input)).ok).toBe(true);
    const calls = loadAgent.mock.calls as unknown as Array<[string, string]>;
    expect(calls.every((call) => call[0] === "company-a" && call[1] === "agent-a")).toBe(true);
  });

  it("fails closed when disabled or the company-scoped binding is denied", async () => {
    expect(await service({ env: {} }).judge(claims(), input)).toEqual({ ok: false, error: { code: "disabled", retryable: false } });
    expect(await service({ loadAgent: vi.fn(async () => null) }).judge(claims("run", "company-b"), input)).toEqual({ ok: false, error: { code: "credential_denied", retryable: false } });
  });

  it.each([
    [429, "rate_limited"], [529, "overloaded"], [500, "service_error"], [401, "credential_denied"],
  ])("returns a bounded error for HTTP %s", async (status, code) => {
    const fetch = vi.fn(async () => new Response("{}", { status }));
    const actual = await service({ fetch }).judge(claims(), input);
    expect(actual).toMatchObject({ ok: false, error: { code } });
    expect(fetch).toHaveBeenCalledTimes(status === 429 || status === 529 ? 2 : 1);
  });

  it("fails closed for timeout, transport error, malformed output, and stale revisions", async () => {
    const abort = Object.assign(new Error("timeout"), { name: "AbortError" });
    expect(await service({ fetch: vi.fn(async () => { throw abort; }) }).judge(claims(), input)).toEqual({ ok: false, error: { code: "timeout", retryable: true } });
    expect(await service({ fetch: vi.fn(async () => { throw new Error("offline"); }) }).judge(claims(), input)).toEqual({ ok: false, error: { code: "service_error", retryable: true } });
    expect(await service({ fetch: vi.fn(async () => new Response(JSON.stringify({ model: "jev", answers: {}, usage: {} }), { status: 200 })) }).judge(claims(), input)).toEqual({ ok: false, error: { code: "invalid_response", retryable: false } });
    const resolveSecret = vi.fn().mockResolvedValueOnce({ value: "key", secretVersionId: "v1" }).mockResolvedValueOnce({ value: "key", secretVersionId: "v2" });
    expect(await service({ resolveSecret }).judge(claims(), input)).toEqual({ ok: false, error: { code: "stale_configuration", retryable: true } });
    const loadCatalogRevision = vi.fn().mockResolvedValueOnce("catalog-1").mockResolvedValueOnce("catalog-2");
    expect(await service({ loadCatalogRevision }).judge(claims(), input)).toEqual({ ok: false, error: { code: "stale_configuration", retryable: true } });
  });
});

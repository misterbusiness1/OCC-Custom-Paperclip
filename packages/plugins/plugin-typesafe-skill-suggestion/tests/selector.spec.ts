import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSuggestionCache, CONTRACT_VERSION, DEFAULT_MODEL_VERSION, QUESTION_VERSION, requestFingerprint, suggest, suggestionCacheSize, type DecisionClient, type SuggestionRequest } from "../src/selector.js";

const makeRequest = (overrides: Partial<SuggestionRequest> = {}): SuggestionRequest => {
  const request = overrides.request ?? "Review this PHP plugin";
  return {
    identity: {
      companyId: "company-a", bindingId: "binding-a", bindingRevision: "binding-a:1", secretVersionId: "secret-a:1",
      configRevision: "config-a:1", catalogRevision: "catalog-a", requestFingerprint: requestFingerprint(request),
      questionVersion: QUESTION_VERSION, contractVersion: CONTRACT_VERSION, model: DEFAULT_MODEL_VERSION,
      ...overrides.identity,
    },
    request,
    skills: [{ id: "php", name: "php", description: "Review PHP" }, { id: "docs", name: "docs", description: "Write docs" }, { id: "qa", name: "qa", description: "Browser QA" }],
    explicitSkillIds: [], mandatorySkillIds: [], ...overrides,
  };
};
const makeClient = (verifyGate = 0.9): DecisionClient & { rank: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> } => ({
  rank: vi.fn(async () => ({ model: DEFAULT_MODEL_VERSION, id: "php", confidence: 0.8,
    probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, gate: 0.9, usage: { input_tokens: 10, output_tokens: 2 } })),
  verify: vi.fn(async () => ({ model: DEFAULT_MODEL_VERSION, id: "php", confidence: 0.85,
    probabilities: { php: 0.8, docs: 0.15, qa: 0.05 }, gate: verifyGate, usage: { input_tokens: 5, output_tokens: 1 } })),
});

describe("skill suggestion selector", () => {
  beforeEach(clearSuggestionCache);
  it("returns at most one closed-set verified suggestion", async () => expect((await suggest(makeRequest(), makeClient())).suggestion).toBe("php"));
  it("allows uncertainty thresholds to reject every candidate", async () => expect((await suggest(makeRequest(), makeClient(0.1))).suggestion).toBeNull());
  it("preserves explicit precedence without provider calls", async () => {
    const client = makeClient(); const value = await suggest(makeRequest({ explicitSkillIds: ["docs"] }), client);
    expect(value.outcome).toBe("explicit_precedence"); expect(client.rank).not.toHaveBeenCalled();
  });
  it("preserves mandatory precedence", async () => expect((await suggest(makeRequest({ mandatorySkillIds: ["qa"] }), makeClient())).outcome).toBe("mandatory_precedence"));
  it("returns no match for an empty catalog", async () => expect((await suggest(makeRequest({ skills: [] }), makeClient())).suggestion).toBeNull());
  it.each(["companyId", "bindingId", "bindingRevision", "secretVersionId", "configRevision", "catalogRevision", "requestFingerprint", "model"] as const)("isolates cache by %s", async (field) => {
    const client = makeClient(); const first = makeRequest(); await suggest(first, client);
    const identity = { ...first.identity, [field]: `${first.identity[field]}-other` };
    if (field === "requestFingerprint") identity.requestFingerprint = requestFingerprint("different");
    const second = field === "requestFingerprint" ? makeRequest({ request: "different", identity }) : makeRequest({ identity });
    if (field === "model") { client.rank.mockImplementation(async () => ({ model: identity.model, id: "php", confidence: 0.8, probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, gate: 0.9, usage: { input_tokens: 1, output_tokens: 1 } })); client.verify.mockImplementation(async () => ({ model: identity.model, id: "php", confidence: 0.8, probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, gate: 0.9, usage: { input_tokens: 1, output_tokens: 1 } })); }
    await suggest(second, client); expect(client.rank).toHaveBeenCalledTimes(2);
  });
  it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid finite/range probability %s", async (bad) => {
    const client = makeClient(); client.rank.mockResolvedValueOnce({ model: DEFAULT_MODEL_VERSION, id: "php", confidence: bad, probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, gate: 0.9, usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(suggest(makeRequest(), client)).rejects.toHaveProperty("name", "InvalidResponseError");
  });
  it("rejects selected options outside the supplied catalog", async () => {
    const client = makeClient(); client.rank.mockResolvedValueOnce({ model: DEFAULT_MODEL_VERSION, id: "unknown", confidence: 0.8, probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, gate: 0.9, usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(suggest(makeRequest(), client)).rejects.toHaveProperty("name", "InvalidResponseError");
  });
  it.each([
    { label: "zero-sum", probabilities: { php: 0, docs: 0, qa: 0 }, id: "php" },
    { label: "sum greater than one", probabilities: { php: 0.7, docs: 0.4, qa: 0.1 }, id: "php" },
    { label: "selected option is not an argmax", probabilities: { php: 0.2, docs: 0.7, qa: 0.1 }, id: "php" },
  ])("rejects malformed $label distributions", async ({ probabilities, id }) => {
    const client = makeClient();
    client.rank.mockResolvedValueOnce({ model: DEFAULT_MODEL_VERSION, id, confidence: 0.8, probabilities, gate: 0.9,
      usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(suggest(makeRequest(), client)).rejects.toHaveProperty("name", "InvalidResponseError");
  });
  it("accepts a normalized distribution when the selected option is honestly tied within tolerance", async () => {
    const client = makeClient();
    client.rank.mockResolvedValueOnce({ model: DEFAULT_MODEL_VERSION, id: "docs", confidence: 0.8,
      probabilities: { php: 0.5000004, docs: 0.4999996, qa: 0 }, gate: 0.9, usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(suggest(makeRequest(), client)).resolves.toMatchObject({ outcome: "suggested" });
  });
  it("coalesces concurrent duplicates", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const client = makeClient();
    client.rank.mockImplementationOnce(async () => { await gate; return { model: DEFAULT_MODEL_VERSION, id: "php", confidence: 0.8, probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, gate: 0.9, usage: { input_tokens: 10, output_tokens: 2 } }; });
    const first = suggest(makeRequest(), client); const second = suggest(makeRequest(), client); release();
    expect((await second).cache).toBe("coalesced"); await first; expect(client.rank).toHaveBeenCalledTimes(1);
  });
  it("bounds cache entries", async () => {
    const client = makeClient();
    for (let i = 0; i < 4; i += 1) await suggest(makeRequest({ identity: { ...makeRequest().identity, catalogRevision: `catalog-${i}` }, cacheMaxEntries: 2 }), client);
    expect(suggestionCacheSize()).toBe(2);
  });
});

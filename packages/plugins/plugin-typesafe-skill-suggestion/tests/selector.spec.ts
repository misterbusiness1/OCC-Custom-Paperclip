import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSuggestionCache, CONTRACT_VERSION, suggest, type SuggestionRequest } from "../src/selector.js";

const request = (overrides: Partial<SuggestionRequest> = {}): SuggestionRequest => ({
  contractVersion: CONTRACT_VERSION, request: "Review this PHP plugin", catalogVersion: "catalog-a",
  skills: [{ name: "php", description: "Review PHP" }, { name: "docs", description: "Write docs" }, { name: "qa", description: "Browser QA" }],
  explicitSkillNames: [], mandatorySkillNames: [], ...overrides,
});
const client = (pass2Acceptable = 0.9) => ({
  rank: vi.fn(async () => ({ model: "jev-1.13.0", name: "php", confidence: 0.8,
    probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, needed: 0.9, usage: { input_tokens: 10, output_tokens: 2 } })),
  verify: vi.fn(async () => ({ model: "jev-1.13.0", name: "php", confidence: 0.85,
    probabilities: { php: 0.8, docs: 0.15, qa: 0.05 }, acceptable: pass2Acceptable, usage: { input_tokens: 5, output_tokens: 1 } })),
});

describe("skill suggestion selector", () => {
  beforeEach(clearSuggestionCache);
  it("returns at most one verified suggestion", async () => expect((await suggest(request(), client())).suggestion).toBe("php"));
  it("allows pass two to reject every candidate", async () => expect((await suggest(request(), client(0.1))).suggestion).toBeNull());
  it("preserves explicit precedence without provider calls", async () => {
    const c = client(); const value = await suggest(request({ explicitSkillNames: ["docs"] }), c);
    expect(value.outcome).toBe("explicit_precedence"); expect(value.suggestion).toBe("docs"); expect(c.rank).not.toHaveBeenCalled();
  });
  it("preserves mandatory precedence", async () => expect((await suggest(request({ mandatorySkillNames: ["qa"] }), client())).outcome).toBe("mandatory_precedence"));
  it("returns no match for an empty roster", async () => expect((await suggest(request({ skills: [] }), client())).suggestion).toBeNull());
  it("invalidates cache when catalog version changes", async () => {
    const c = client(); await suggest(request(), c); await suggest(request({ catalogVersion: "catalog-b" }), c); expect(c.rank).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent duplicates", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const c = client();
    c.rank.mockImplementationOnce(async () => { await gate; return { model: "jev-1.13.0", name: "php", confidence: 0.8,
      probabilities: { php: 0.7, docs: 0.2, qa: 0.1 }, needed: 0.9, usage: { input_tokens: 10, output_tokens: 2 } }; });
    const first = suggest(request(), c); const second = suggest(request(), c); release();
    expect((await second).cache).toBe("coalesced"); await first; expect(c.rank).toHaveBeenCalledTimes(1);
  });
});

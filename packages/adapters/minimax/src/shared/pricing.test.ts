import { afterEach, describe, expect, it } from "vitest";
import { computeMiniMaxCostUsd, DEFAULT_MINIMAX_RATE_CARD, hasConfiguredMiniMaxRate } from "./pricing.js";
import { addBoundedTokens, extractUsage, MAX_TOKENS_PER_RESPONSE, MAX_TOKENS_PER_RUN } from "../server/response.js";

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 };
const m3 = DEFAULT_MINIMAX_RATE_CARD["MiniMax-M3"]!;
const defaultCost = m3.inputPerMTok + m3.outputPerMTok;

describe("minimax_local pricing bounds", () => {
  afterEach(() => {
    delete process.env.MINIMAX_LOCAL_PRICING_JSON;
  });

  it("ignores negative or zero tenant rates (no $0 / negative cost to dodge budgets)", () => {
    for (const rate of [
      { inputPerMTok: -50, outputPerMTok: -50 },
      { inputPerMTok: 0, outputPerMTok: 0 },
      { inputPerMTok: 1, outputPerMTok: 0 },
      { inputPerMTok: Number.NaN, outputPerMTok: 1 },
    ]) {
      const config = { pricing: { "MiniMax-M3": rate } };
      expect(hasConfiguredMiniMaxRate(config, "MiniMax-M3")).toBe(false);
      const cost = computeMiniMaxCostUsd("MiniMax-M3", usage, config);
      expect(cost?.usedDefaultRate).toBe(true);
      expect(cost?.costUsd).toBeCloseTo(defaultCost, 9);
    }
  });

  it("ignores an out-of-range rate and leaves an unknown model unpriced", () => {
    const config = { pricing: { "MiniMax-Future-9": { inputPerMTok: 1e12, outputPerMTok: 1e12 } } };
    expect(computeMiniMaxCostUsd("MiniMax-Future-9", usage, config)).toBeNull();
  });

  it("applies the same bounds to MINIMAX_LOCAL_PRICING_JSON", () => {
    process.env.MINIMAX_LOCAL_PRICING_JSON = JSON.stringify({ "MiniMax-M3": { inputPerMTok: -1, outputPerMTok: 5 } });
    expect(hasConfiguredMiniMaxRate({}, "MiniMax-M3")).toBe(false);
  });

  it("clamps a negative cached rate away and caps it at the input rate", () => {
    const negative = computeMiniMaxCostUsd(
      "MiniMax-M3",
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
      { pricing: { "MiniMax-M3": { inputPerMTok: 2, outputPerMTok: 2, cachedInputPerMTok: -10 } } },
    );
    expect(negative?.costUsd).toBeCloseTo(2, 9);
    const above = computeMiniMaxCostUsd(
      "MiniMax-M3",
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 },
      { pricing: { "MiniMax-M3": { inputPerMTok: 2, outputPerMTok: 2, cachedInputPerMTok: 50 } } },
    );
    expect(above?.costUsd).toBeCloseTo(2, 9);
  });

  it("bounds upstream token counts so the integer ledger cannot overflow", () => {
    const huge = extractUsage({
      usage: { prompt_tokens: 1e300, completion_tokens: Infinity, prompt_tokens_details: { cached_tokens: -5 } },
    });
    expect(huge.inputTokens).toBe(MAX_TOKENS_PER_RESPONSE);
    expect(huge.outputTokens).toBe(0);
    expect(huge.cachedInputTokens).toBe(0);
    let total = 0;
    for (let i = 0; i < 1000; i += 1) total = addBoundedTokens(total, MAX_TOKENS_PER_RESPONSE);
    expect(total).toBe(MAX_TOKENS_PER_RUN);
    expect(Number.isSafeInteger(total)).toBe(true);
    expect(total).toBeLessThan(2 ** 31);
  });
});

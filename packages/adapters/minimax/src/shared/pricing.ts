import { asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { normalizeMiniMaxModel } from "./model.js";

export interface MiniMaxModelRate {
  // USD per 1,000,000 tokens.
  inputPerMTok: number;
  outputPerMTok: number;
  // Cached input tokens are typically billed at a large discount; falls back
  // to the input rate when unset.
  cachedInputPerMTok?: number;
}

export interface UsageForPricing {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

// Default MiniMax rate card (USD per 1M tokens).
//
// IMPORTANT: these are UNVERIFIED ESTIMATES carried over from the original
// fork so budgets enforce (a non-zero cost is recorded) before exact rates are
// configured. Verify against current MiniMax pricing and override per
// deployment via adapterConfig.pricing.<modelId> = { inputPerMTok, outputPerMTok }
// or the MINIMAX_LOCAL_PRICING_JSON env var. execute() says in its invocation
// notes whether the estimate or a configured rate is in use. A model with no
// rate at all (unknown id, no override) is left unpriced (costUsd undefined).
export const DEFAULT_MINIMAX_RATE_CARD: Record<string, MiniMaxModelRate> = {
  "MiniMax-M3": { inputPerMTok: 0.3, outputPerMTok: 1.2, cachedInputPerMTok: 0.03 },
  "MiniMax-M2.7": { inputPerMTok: 0.3, outputPerMTok: 1.2, cachedInputPerMTok: 0.03 },
  "MiniMax-M2.7-highspeed": { inputPerMTok: 0.5, outputPerMTok: 2.2, cachedInputPerMTok: 0.05 },
};

function readRateFromConfig(config: Record<string, unknown>, model: string): MiniMaxModelRate | null {
  const candidates: Array<Record<string, unknown>> = [];

  const configPricing = parseObject(config.pricing);
  if (configPricing[model]) candidates.push(parseObject(configPricing[model]));

  const envRaw = process.env.MINIMAX_LOCAL_PRICING_JSON;
  if (envRaw) {
    try {
      const envPricing = parseObject(JSON.parse(envRaw));
      if (envPricing[model]) candidates.push(parseObject(envPricing[model]));
    } catch {
      // ignore malformed env pricing
    }
  }

  for (const cand of candidates) {
    const input = asNumber(cand.inputPerMTok, NaN);
    const output = asNumber(cand.outputPerMTok, NaN);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      const cached = asNumber(cand.cachedInputPerMTok, NaN);
      return {
        inputPerMTok: input,
        outputPerMTok: output,
        ...(Number.isFinite(cached) ? { cachedInputPerMTok: cached } : {}),
      };
    }
  }
  return null;
}

// True when an explicit rate (adapterConfig.pricing or MINIMAX_LOCAL_PRICING_JSON)
// exists for the model, i.e. the default estimate card is NOT in use.
export function hasConfiguredMiniMaxRate(config: Record<string, unknown>, model: string): boolean {
  return readRateFromConfig(config, normalizeMiniMaxModel(model)) !== null;
}

export interface CostComputation {
  costUsd: number;
  // True when the built-in default card was used (no explicit rate configured).
  usedDefaultRate: boolean;
}

// Compute the USD cost of a run from reported tokens. Cached input tokens are
// priced at the cached rate and are treated as a subset of inputTokens (so they
// are not double-charged at the full input rate).
export function computeMiniMaxCostUsd(
  model: string,
  usage: UsageForPricing,
  config: Record<string, unknown>,
): CostComputation | null {
  const canonical = normalizeMiniMaxModel(model);
  const configured = readRateFromConfig(config, canonical);
  const rate = configured ?? DEFAULT_MINIMAX_RATE_CARD[canonical] ?? null;
  if (!rate) return null;

  const cached = Math.max(0, Math.min(usage.cachedInputTokens, usage.inputTokens));
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const cachedRate = rate.cachedInputPerMTok ?? rate.inputPerMTok;

  const costUsd =
    (uncachedInput * rate.inputPerMTok +
      cached * cachedRate +
      usage.outputTokens * rate.outputPerMTok) /
    1_000_000;

  return { costUsd, usedDefaultRate: configured === null };
}

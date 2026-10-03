import { createHash } from "node:crypto";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";

export const CONTRACT_VERSION = "skill-suggestion-active.v2";
export const SHADOW_CONTRACT_VERSION = "skill-suggestion-shadow.v1";
export const QUESTION_VERSION = "occ-skill-suggestion.2026-10-03";
export const DEFAULT_MODEL_VERSION = "jev-1.13.0";
const MAX_EXCERPT_CHARS = 2_000;
const DEFAULT_CACHE_TTL_MS = 300_000;
const DEFAULT_CACHE_MAX = 128;

export type SkillCandidate = { id: string; name: string; description: string; excerpt?: string };
export type SuggestionIdentity = {
  companyId: string;
  bindingId: string;
  bindingRevision: string;
  secretVersionId: string;
  configRevision: string;
  catalogRevision: string;
  requestFingerprint: string;
  questionVersion: typeof QUESTION_VERSION;
  contractVersion: typeof CONTRACT_VERSION;
  model: string;
};
export type SuggestionRequest = {
  identity: SuggestionIdentity;
  request: string;
  skills: SkillCandidate[];
  explicitSkillIds: string[];
  mandatorySkillIds: string[];
  minNeededProbability?: number;
  minAcceptableProbability?: number;
  minConfidence?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
};
export type SuggestionResult = {
  contractVersion: typeof CONTRACT_VERSION;
  identity: SuggestionIdentity;
  suggestion: string | null;
  shortlist: Array<{ id: string; probability: number }>;
  confidence: number | null;
  neededProbability: number | null;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
  outcome: "suggested" | "no_match" | "explicit_precedence" | "mandatory_precedence";
  cache: "hit" | "miss" | "coalesced";
};

type DecisionResponse = {
  model: string; id: string; confidence: number; probabilities: Record<string, number>;
  gate: number; usage: { input_tokens: number; output_tokens: number };
};
export type DecisionClient = {
  rank(state: Record<string, JsonValue>, ids: string[]): Promise<DecisionResponse>;
  verify(state: Record<string, JsonValue>, ids: string[]): Promise<DecisionResponse>;
};

export function createDecisionClient(apiKey: string, model: string, timeoutMs: number, maxRetries: number): DecisionClient {
  const client = new TypeSafeClient({ apiKey, defaultModel: model, timeout: timeoutMs,
    retry: { maxRetries }, logLevel: "warn" });
  return {
    async rank(state, ids) {
      const result = await client.systemOne({ model, state, questions: {
        skill: choice("Choose the single skill whose supplied description best matches `request`. Rank only; do not assume a skill is necessary.", Object.fromEntries(ids.map((id) => [id, `The candidate identified as ${id}.`]))),
        needed: noul("Would loading one specialized candidate materially help complete `request`?", { true: "A listed candidate is materially useful.", false: "Current general behavior is sufficient." }),
      }});
      return { model: result.model, id: result.answers.skill.choice, confidence: result.answers.skill.confidence,
        probabilities: result.answers.skill.probabilities, gate: result.answers.needed.noul, usage: result.usage };
    },
    async verify(state, ids) {
      const result = await client.systemOne({ model, state, questions: {
        skill: choice("Choose the best candidate for `request`; code may reject this ranking independently.", Object.fromEntries(ids.map((id) => [id, `The candidate identified as ${id}.`]))),
        acceptable: noul("Is the best candidate sufficiently relevant to advise loading for `request`?", { true: "Advise the best candidate.", false: "Reject all candidates." }),
      }});
      return { model: result.model, id: result.answers.skill.choice, confidence: result.answers.skill.confidence,
        probabilities: result.answers.skill.probabilities, gate: result.answers.acceptable.noul, usage: result.usage };
    },
  };
}

export function normalizeRequest(value: string) { return value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 8_000); }
export function requestFingerprint(value: string) { return createHash("sha256").update(normalizeRequest(value)).digest("hex"); }
function bounded(candidate: SkillCandidate): SkillCandidate {
  return { id: candidate.id, name: candidate.name.slice(0, 200), description: candidate.description.slice(0, 1_000), excerpt: candidate.excerpt?.slice(0, MAX_EXCERPT_CHARS) };
}
export function cacheKey(input: SuggestionRequest) {
  return createHash("sha256").update(JSON.stringify(input.identity)).digest("hex");
}
function probability(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
const DISTRIBUTION_TOLERANCE = 1e-6;
function validResponse(value: DecisionResponse, allowed: Set<string>, model: string) {
  if (value.model !== model || !allowed.has(value.id) || !probability(value.confidence) || !probability(value.gate)) return false;
  if (!Number.isFinite(value.usage.input_tokens) || value.usage.input_tokens < 0 || !Number.isFinite(value.usage.output_tokens) || value.usage.output_tokens < 0) return false;
  const entries = Object.entries(value.probabilities);
  if (entries.length !== allowed.size || !entries.every(([id, p]) => allowed.has(id) && probability(p))) return false;
  const sum = entries.reduce((total, [, p]) => total + p, 0);
  if (Math.abs(sum - 1) > DISTRIBUTION_TOLERANCE) return false;
  const selected = value.probabilities[value.id];
  const maximum = Math.max(...entries.map(([, p]) => p));
  return selected !== undefined && maximum - selected <= DISTRIBUTION_TOLERANCE;
}
function threshold(value: number | undefined, fallback: number) { return probability(value) ? value! : fallback; }

const cache = new Map<string, { expires: number; value: SuggestionResult }>();
const inflight = new Map<string, Promise<SuggestionResult>>();
export function clearSuggestionCache() { cache.clear(); inflight.clear(); }
export function suggestionCacheSize() { return cache.size; }

export async function suggest(input: SuggestionRequest, client: DecisionClient): Promise<SuggestionResult> {
  const started = performance.now();
  if (input.identity.contractVersion !== CONTRACT_VERSION || input.identity.questionVersion !== QUESTION_VERSION || input.identity.requestFingerprint !== requestFingerprint(input.request)) {
    throw Object.assign(new Error("request identity mismatch"), { name: "InvalidRequestIdentityError" });
  }
  const base = { contractVersion: CONTRACT_VERSION, identity: input.identity } as const;
  const precedence = input.mandatorySkillIds[0] ?? input.explicitSkillIds[0];
  if (precedence) return { ...base, suggestion: precedence, shortlist: [], confidence: 1, neededProbability: 1,
    latencyMs: Math.round(performance.now() - started), usage: { inputTokens: 0, outputTokens: 0 },
    outcome: input.mandatorySkillIds.length ? "mandatory_precedence" : "explicit_precedence", cache: "miss" };
  if (!input.skills.length) return { ...base, suggestion: null, shortlist: [], confidence: null, neededProbability: null,
    latencyMs: Math.round(performance.now() - started), usage: { inputTokens: 0, outputTokens: 0 }, outcome: "no_match", cache: "miss" };
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cache: "hit" };
  if (hit) cache.delete(key);
  const pending = inflight.get(key);
  if (pending) return { ...(await pending), cache: "coalesced" };
  const work = (async () => {
    const roster = input.skills.map(bounded);
    const ids = roster.map((skill) => skill.id);
    const allowed = new Set(ids);
    if (allowed.size !== ids.length) throw Object.assign(new Error("duplicate candidate id"), { name: "InvalidCandidateError" });
    const request = normalizeRequest(input.request);
    const pass1 = await client.rank({ request, skills: roster.map(({ id, name, description }) => ({ id, name, description })) }, ids);
    if (!validResponse(pass1, allowed, input.identity.model)) throw Object.assign(new Error("invalid rank response"), { name: "InvalidResponseError" });
    const shortlist = Object.entries(pass1.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, p]) => ({ id, probability: p }));
    let suggestion: string | null = null;
    let confidence = pass1.confidence;
    let usage = { inputTokens: pass1.usage.input_tokens, outputTokens: pass1.usage.output_tokens };
    if (pass1.gate >= threshold(input.minNeededProbability, 0.6) && pass1.confidence >= threshold(input.minConfidence, 0.55) && shortlist.length) {
      const candidateIds = shortlist.map(({ id }) => id);
      const candidates = roster.filter((skill) => candidateIds.includes(skill.id));
      const pass2 = await client.verify({ request, candidates }, candidateIds);
      const pass2Allowed = new Set(candidateIds);
      if (!validResponse(pass2, pass2Allowed, input.identity.model)) throw Object.assign(new Error("invalid verify response"), { name: "InvalidResponseError" });
      confidence = pass2.confidence;
      usage = { inputTokens: usage.inputTokens + pass2.usage.input_tokens, outputTokens: usage.outputTokens + pass2.usage.output_tokens };
      if (pass2.gate >= threshold(input.minAcceptableProbability, 0.65) && pass2.confidence >= threshold(input.minConfidence, 0.55)) suggestion = pass2.id;
    }
    const value: SuggestionResult = { ...base, suggestion, shortlist, confidence, neededProbability: pass1.gate,
      latencyMs: Math.round(performance.now() - started), usage, outcome: suggestion ? "suggested" : "no_match", cache: "miss" };
    const maxEntries = Math.max(1, Math.min(512, Math.floor(input.cacheMaxEntries ?? DEFAULT_CACHE_MAX)));
    while (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + Math.max(1_000, Math.min(900_000, input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)), value });
    return value;
  })();
  inflight.set(key, work);
  try { return await work; } finally { inflight.delete(key); }
}

import { createHash } from "node:crypto";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";

export const CONTRACT_VERSION = "skill-suggestion-shadow.v1";
export const QUESTION_VERSION = "occ-skill-suggestion.2026-10-01";
export const MODEL_VERSION = "jev-1.13.0";
const MAX_EXCERPT_CHARS = 2_000;

export type SkillCandidate = { name: string; description: string; excerpt?: string };
export type SuggestionRequest = {
  contractVersion: typeof CONTRACT_VERSION;
  request: string;
  catalogVersion: string;
  skills: SkillCandidate[];
  explicitSkillNames: string[];
  mandatorySkillNames: string[];
};
export type SuggestionResult = {
  contractVersion: typeof CONTRACT_VERSION;
  suggestion: string | null;
  shortlist: Array<{ name: string; probability: number }>;
  confidence: number | null;
  neededProbability: number | null;
  catalogVersion: string;
  questionVersion: typeof QUESTION_VERSION;
  modelVersion: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
  outcome: "suggested" | "no_match" | "explicit_precedence" | "mandatory_precedence";
  cache: "hit" | "miss" | "coalesced";
};

type DecisionClient = {
  rank(state: Record<string, JsonValue>, names: string[]): Promise<{
    model: string; name: string; confidence: number; probabilities: Record<string, number>;
    needed: number; usage: { input_tokens: number; output_tokens: number };
  }>;
  verify(state: Record<string, JsonValue>, names: string[]): Promise<{
    model: string; name: string; confidence: number; probabilities: Record<string, number>;
    acceptable: number; usage: { input_tokens: number; output_tokens: number };
  }>;
};

export function createDecisionClient(apiKey: string, timeoutMs: number, maxRetries: number): DecisionClient {
  const client = new TypeSafeClient({ apiKey, defaultModel: MODEL_VERSION, timeout: timeoutMs,
    retry: { maxRetries }, logLevel: "warn" });
  return {
    async rank(state, names) {
      const result = await client.systemOne({ model: MODEL_VERSION, state, questions: {
        skill: choice("Choose the single skill whose description best matches `request`. Rank only; do not assume a skill is necessary.", Object.fromEntries(names.map((name) => [name, `The skill named ${name}.`]))),
        needed: noul("Would loading a specialized skill materially help complete `request`?", { true: "A listed skill is materially useful.", false: "Current general behavior is sufficient." }),
      }});
      return { model: result.model, name: result.answers.skill.choice, confidence: result.answers.skill.confidence,
        probabilities: result.answers.skill.probabilities, needed: result.answers.needed.noul, usage: result.usage };
    },
    async verify(state, names) {
      const result = await client.systemOne({ model: MODEL_VERSION, state, questions: {
        skill: choice("Choose the best candidate for `request`; this ranking may be rejected independently.", Object.fromEntries(names.map((name) => [name, `The skill named ${name}.`]))),
        acceptable: noul("Is the best candidate sufficiently relevant to load for `request`?", { true: "Load the best candidate.", false: "Reject all candidates." }),
      }});
      return { model: result.model, name: result.answers.skill.choice, confidence: result.answers.skill.confidence,
        probabilities: result.answers.skill.probabilities, acceptable: result.answers.acceptable.noul, usage: result.usage };
    },
  };
}

function normalizeRequest(value: string) { return value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 8_000); }
function bounded(candidate: SkillCandidate): SkillCandidate {
  return { name: candidate.name, description: candidate.description.slice(0, 1_000), excerpt: candidate.excerpt?.slice(0, MAX_EXCERPT_CHARS) };
}
export function cacheKey(input: SuggestionRequest) {
  return createHash("sha256").update(JSON.stringify({ request: normalizeRequest(input.request), catalogVersion: input.catalogVersion,
    questionVersion: QUESTION_VERSION, modelVersion: MODEL_VERSION })).digest("hex");
}

const cache = new Map<string, { expires: number; value: SuggestionResult }>();
const inflight = new Map<string, Promise<SuggestionResult>>();
export function clearSuggestionCache() { cache.clear(); inflight.clear(); }

export async function suggest(input: SuggestionRequest, client: DecisionClient): Promise<SuggestionResult> {
  const started = performance.now();
  const base = { contractVersion: CONTRACT_VERSION, catalogVersion: input.catalogVersion,
    questionVersion: QUESTION_VERSION, modelVersion: MODEL_VERSION } as const;
  const precedence = input.mandatorySkillNames[0] ?? input.explicitSkillNames[0];
  if (precedence) return { ...base, suggestion: precedence, shortlist: [], confidence: 1, neededProbability: 1,
    latencyMs: Math.round(performance.now() - started), usage: { inputTokens: 0, outputTokens: 0 },
    outcome: input.mandatorySkillNames.length ? "mandatory_precedence" : "explicit_precedence", cache: "miss" };
  if (!input.skills.length) return { ...base, suggestion: null, shortlist: [], confidence: null, neededProbability: null,
    latencyMs: Math.round(performance.now() - started), usage: { inputTokens: 0, outputTokens: 0 }, outcome: "no_match", cache: "miss" };
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cache: "hit" };
  const pending = inflight.get(key);
  if (pending) return { ...(await pending), cache: "coalesced" };
  const work = (async () => {
    const roster = input.skills.map(bounded);
    const request = normalizeRequest(input.request);
    const pass1 = await client.rank({ request, skills: roster.map(({ name, description }) => ({ name, description })) }, roster.map((s) => s.name));
    const shortlist = Object.entries(pass1.probabilities).filter(([, p]) => Number.isFinite(p)).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, probability]) => ({ name, probability }));
    let suggestion: string | null = null;
    let confidence = pass1.confidence;
    let usage = { inputTokens: pass1.usage.input_tokens, outputTokens: pass1.usage.output_tokens };
    let modelVersion = pass1.model;
    if (pass1.needed >= 0.5 && shortlist.length) {
      const candidates = shortlist.map(({ name }) => roster.find((s) => s.name === name)).filter((s): s is SkillCandidate => Boolean(s));
      const pass2 = await client.verify({ request, candidates }, candidates.map((s) => s.name));
      confidence = pass2.confidence; modelVersion = pass2.model;
      usage = { inputTokens: usage.inputTokens + pass2.usage.input_tokens, outputTokens: usage.outputTokens + pass2.usage.output_tokens };
      if (pass2.acceptable >= 0.5 && candidates.some((s) => s.name === pass2.name)) suggestion = pass2.name;
    }
    const value: SuggestionResult = { ...base, modelVersion, suggestion, shortlist, confidence,
      neededProbability: pass1.needed, latencyMs: Math.round(performance.now() - started), usage,
      outcome: suggestion ? "suggested" : "no_match", cache: "miss" };
    cache.set(key, { expires: Date.now() + 300_000, value });
    return value;
  })();
  inflight.set(key, work);
  try { return await work; } finally { inflight.delete(key); }
}

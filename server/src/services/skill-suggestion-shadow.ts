import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export const SKILL_SUGGESTION_SHADOW_CONTRACT_VERSION = "skill-suggestion-shadow.v1";
export const SKILL_SUGGESTION_ACTIVE_CONTRACT_VERSION = "skill-suggestion-active.v2";
export const SKILL_SUGGESTION_ACTION = "skill-suggestion-shadow-v1";

export type SkillSuggestionShadowObservation = {
  contractVersion: string;
  status: "disabled" | "observed" | "failed_open";
  suggestion: string | null;
  shortlist: Array<{ name: string; probability: number }>;
  confidence: number | null;
  neededProbability: number | null;
  catalogRevision: string;
  catalogVersion: string;
  questionVersion: string | null;
  modelVersion: string | null;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  outcome: string;
  errorClass: string | null;
  cache: string | null;
  skillActuallyLoaded: string | null;
  active: boolean;
};

function flag(env: Record<string, string | undefined>, key: string) {
  return ["1", "true", "yes", "on"].includes((env[key] ?? "").toLowerCase());
}
function frontmatter(markdown: string, field: string) {
  const match = markdown.match(new RegExp(`^${field}:\\s*[>|]?\\s*(.+)$`, "mi"));
  return match?.[1]?.trim() ?? "";
}
async function catalogEntry(entry: PaperclipSkillEntry) {
  try {
    const markdown = await fs.readFile(path.join(entry.source, "SKILL.md"), "utf8");
    return { id: entry.key, name: entry.runtimeName, description: frontmatter(markdown, "description"), excerpt: markdown.slice(0, 2_000) };
  } catch { return { id: entry.key, name: entry.runtimeName, description: "", excerpt: "" }; }
}
export function catalogRevision(skills: PaperclipSkillEntry[]) {
  return createHash("sha256").update(JSON.stringify(skills.map((skill) => [skill.key, skill.versionId, skill.currentVersionId]))).digest("hex");
}
function failOpen(revision: string, started: number, error: unknown, active = false): SkillSuggestionShadowObservation {
  return { contractVersion: SKILL_SUGGESTION_SHADOW_CONTRACT_VERSION,
    status: "failed_open", suggestion: null, shortlist: [], confidence: null, neededProbability: null,
    catalogRevision: revision, catalogVersion: revision, questionVersion: null, modelVersion: null,
    latencyMs: Math.round(performance.now() - started), usage: null, outcome: "failed_open",
    errorClass: error instanceof Error ? error.name : "UnknownError", cache: null, skillActuallyLoaded: null, active };
}
function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export async function observeSkillSuggestion(input: {
  env: Record<string, string | undefined>;
  workerManager?: PluginWorkerManager;
  companyId: string;
  request: string;
  skills: PaperclipSkillEntry[];
  readFreshSkills?: () => Promise<PaperclipSkillEntry[]>;
  explicitSkillIds: string[];
  mandatorySkillIds: string[];
}): Promise<SkillSuggestionShadowObservation> {
  const started = performance.now();
  const revision = catalogRevision(input.skills);
  const active = flag(input.env, "PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE");
  const shadow = flag(input.env, "PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW");
  if (!active && !shadow) return { ...failOpen(revision, started, new Error("disabled")), status: "disabled", outcome: "disabled", errorClass: null };
  const pluginId = input.env.PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID?.trim();
  if (!pluginId || !input.workerManager?.isRunning(pluginId)) return failOpen(revision, started, new Error("WorkerUnavailable"), active);
  try {
    const skills = await Promise.all(input.skills.map(catalogEntry));
    const result = await input.workerManager.call(pluginId, "performAction", {
      key: SKILL_SUGGESTION_ACTION, companyId: input.companyId,
      actorContext: { type: "system", userId: null, agentId: null, runId: null, companyId: input.companyId },
      params: { mode: active ? "active" : "shadow", request: input.request, catalogRevision: revision,
        skills, explicitSkillIds: input.explicitSkillIds, mandatorySkillIds: input.mandatorySkillIds },
    }, 16_000) as Record<string, unknown>;
    if (result.disabled === true) return { ...failOpen(revision, started, new Error("disabled"), active), status: "disabled", outcome: "disabled", errorClass: null };
    if (!active) {
      const shortlist = Array.isArray(result.shortlist) ? result.shortlist : [];
      const validLegacyShortlist = shortlist.every((row) => row && typeof row === "object" &&
        typeof (row as Record<string, unknown>).name === "string" && finiteProbability((row as Record<string, unknown>).probability));
      if (!validLegacyShortlist || (result.suggestion !== null && typeof result.suggestion !== "string") ||
        !finiteProbability(result.confidence) || !finiteProbability(result.neededProbability) ||
        typeof result.questionVersion !== "string" || typeof result.modelVersion !== "string") {
        throw Object.assign(new Error("malformed shadow result"), { name: "InvalidResponseError" });
      }
      return { contractVersion: SKILL_SUGGESTION_SHADOW_CONTRACT_VERSION, status: "observed",
        suggestion: result.suggestion as string | null,
        shortlist: shortlist as Array<{ name: string; probability: number }>, confidence: result.confidence,
        neededProbability: result.neededProbability, catalogRevision: revision, catalogVersion: revision,
        questionVersion: result.questionVersion, modelVersion: result.modelVersion,
        latencyMs: typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs) ? result.latencyMs : Math.round(performance.now() - started),
        usage: result.usage && typeof result.usage === "object" ? result.usage as { inputTokens: number; outputTokens: number } : null,
        outcome: typeof result.outcome === "string" ? result.outcome : "no_match", errorClass: null,
        cache: typeof result.cache === "string" ? result.cache : null, skillActuallyLoaded: null, active: false };
    }
    const identity = result.identity && typeof result.identity === "object" ? result.identity as Record<string, unknown> : null;
    const installedIds = new Set(input.skills.map((skill) => skill.key));
    const suggestion = typeof result.suggestion === "string" ? result.suggestion : null;
    const shortlist = Array.isArray(result.shortlist) ? result.shortlist : [];
    const validShortlist = shortlist.every((row) => row && typeof row === "object" && installedIds.has(String((row as Record<string, unknown>).id)) && finiteProbability((row as Record<string, unknown>).probability));
    if (!identity || identity.companyId !== input.companyId || identity.catalogRevision !== revision || identity.contractVersion !== SKILL_SUGGESTION_ACTIVE_CONTRACT_VERSION ||
      (suggestion !== null && !installedIds.has(suggestion)) || !validShortlist ||
      (result.confidence !== null && !finiteProbability(result.confidence)) || (result.neededProbability !== null && !finiteProbability(result.neededProbability))) {
      throw Object.assign(new Error("malformed suggestion result"), { name: "InvalidResponseError" });
    }
    const freshSkills = input.readFreshSkills ? await input.readFreshSkills() : input.skills;
    if (catalogRevision(freshSkills) !== revision || (suggestion && !freshSkills.some((skill) => skill.key === suggestion))) {
      throw Object.assign(new Error("catalog changed"), { name: "StaleCatalogError" });
    }
    const precedence = input.mandatorySkillIds.length > 0 || input.explicitSkillIds.length > 0;
    return { contractVersion: SKILL_SUGGESTION_SHADOW_CONTRACT_VERSION, status: "observed",
      suggestion: precedence ? null : suggestion,
      shortlist: validShortlist ? shortlist.map((row) => ({ name: String((row as Record<string, unknown>).id), probability: Number((row as Record<string, unknown>).probability) })) : [],
      confidence: finiteProbability(result.confidence) ? result.confidence : null,
      neededProbability: finiteProbability(result.neededProbability) ? result.neededProbability : null,
      catalogRevision: revision, catalogVersion: revision, questionVersion: typeof identity.questionVersion === "string" ? identity.questionVersion : null,
      modelVersion: typeof identity.model === "string" ? identity.model : null,
      latencyMs: typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs) ? result.latencyMs : Math.round(performance.now() - started),
      usage: result.usage && typeof result.usage === "object" && Number.isFinite((result.usage as Record<string, unknown>).inputTokens) && Number.isFinite((result.usage as Record<string, unknown>).outputTokens)
        ? result.usage as { inputTokens: number; outputTokens: number } : null,
      outcome: precedence ? "deterministic_precedence" : typeof result.outcome === "string" ? result.outcome : "invalid_response",
      errorClass: null, cache: typeof result.cache === "string" ? result.cache : null,
      skillActuallyLoaded: null, active: active && !precedence };
  } catch (error) { return failOpen(revision, started, error, active); }
}

export function advisorySkillContext(observation: SkillSuggestionShadowObservation | null) {
  if (!observation || !observation.active || observation.status !== "observed" || observation.outcome !== "suggested" || !observation.suggestion) return null;
  return {
    kind: "skill_relevance_advisory_v1",
    skillId: observation.suggestion,
    instruction: "This installed skill appears relevant. Treat this as advisory only; explicit user-selected and mandatory skill rules take precedence.",
  };
}

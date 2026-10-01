import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export const SKILL_SUGGESTION_CONTRACT_VERSION = "skill-suggestion-shadow.v1";
export const SKILL_SUGGESTION_ACTION = "skill-suggestion-shadow-v1";

export type SkillSuggestionShadowObservation = {
  contractVersion: string;
  status: "disabled" | "observed" | "failed_open";
  suggestion: string | null;
  shortlist: Array<{ name: string; probability: number }>;
  confidence: number | null;
  neededProbability: number | null;
  catalogVersion: string;
  questionVersion: string | null;
  modelVersion: string | null;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  outcome: string;
  errorClass: string | null;
  cache: string | null;
  skillActuallyLoaded: string | null;
};

function enabled(env: Record<string, string | undefined>) {
  return ["1", "true", "yes", "on"].includes((env.PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW ?? "").toLowerCase());
}
function frontmatter(markdown: string, field: string) {
  const match = markdown.match(new RegExp(`^${field}:\\s*[>|]?\\s*(.+)$`, "mi"));
  return match?.[1]?.trim() ?? "";
}
async function catalogEntry(entry: PaperclipSkillEntry) {
  try {
    const markdown = await fs.readFile(path.join(entry.source, "SKILL.md"), "utf8");
    return { name: entry.key, description: frontmatter(markdown, "description"), excerpt: markdown.slice(0, 2_000) };
  } catch { return { name: entry.key, description: "", excerpt: "" }; }
}
function failOpen(catalogVersion: string, started: number, error: unknown): SkillSuggestionShadowObservation {
  return { contractVersion: SKILL_SUGGESTION_CONTRACT_VERSION, status: "failed_open", suggestion: null,
    shortlist: [], confidence: null, neededProbability: null, catalogVersion, questionVersion: null,
    modelVersion: null, latencyMs: Math.round(performance.now() - started), usage: null, outcome: "failed_open",
    errorClass: error instanceof Error ? error.name : "UnknownError", cache: null, skillActuallyLoaded: null };
}

export async function observeSkillSuggestion(input: {
  env: Record<string, string | undefined>;
  workerManager?: PluginWorkerManager;
  companyId: string;
  request: string;
  skills: PaperclipSkillEntry[];
  explicitSkillNames: string[];
  mandatorySkillNames: string[];
}): Promise<SkillSuggestionShadowObservation> {
  const started = performance.now();
  const catalogVersion = createHash("sha256").update(JSON.stringify(input.skills.map((s) => [s.key, s.versionId, s.currentVersionId]))).digest("hex");
  if (!enabled(input.env)) return { ...failOpen(catalogVersion, started, new Error("disabled")), status: "disabled", outcome: "disabled", errorClass: null };
  const pluginId = input.env.PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID?.trim();
  if (!pluginId || !input.workerManager?.isRunning(pluginId)) return failOpen(catalogVersion, started, new Error("WorkerUnavailable"));
  try {
    const skills = await Promise.all(input.skills.map(catalogEntry));
    const result = await input.workerManager.call(pluginId, "performAction", {
      key: SKILL_SUGGESTION_ACTION, companyId: input.companyId,
      actorContext: { type: "system", userId: null, agentId: null, runId: null, companyId: input.companyId },
      params: { contractVersion: SKILL_SUGGESTION_CONTRACT_VERSION, request: input.request, catalogVersion,
        skills, explicitSkillNames: input.explicitSkillNames, mandatorySkillNames: input.mandatorySkillNames },
    }, 16_000) as Record<string, unknown>;
    if (result.disabled === true) return { ...failOpen(catalogVersion, started, new Error("disabled")), status: "disabled", outcome: "disabled", errorClass: null };
    return { contractVersion: SKILL_SUGGESTION_CONTRACT_VERSION, status: "observed",
      suggestion: typeof result.suggestion === "string" ? result.suggestion : null,
      shortlist: Array.isArray(result.shortlist) ? result.shortlist as Array<{ name: string; probability: number }> : [],
      confidence: typeof result.confidence === "number" ? result.confidence : null,
      neededProbability: typeof result.neededProbability === "number" ? result.neededProbability : null,
      catalogVersion, questionVersion: typeof result.questionVersion === "string" ? result.questionVersion : null,
      modelVersion: typeof result.modelVersion === "string" ? result.modelVersion : null,
      latencyMs: typeof result.latencyMs === "number" ? result.latencyMs : Math.round(performance.now() - started),
      usage: result.usage && typeof result.usage === "object" ? result.usage as { inputTokens: number; outputTokens: number } : null,
      outcome: typeof result.outcome === "string" ? result.outcome : "invalid_response", errorClass: null,
      cache: typeof result.cache === "string" ? result.cache : null, skillActuallyLoaded: null };
  } catch (error) { return failOpen(catalogVersion, started, error); }
}

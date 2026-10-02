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

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseResult(result: Record<string, unknown>, catalogVersion: string, started: number): SkillSuggestionShadowObservation {
  const shortlist = result.shortlist;
  const usage = result.usage;
  if (
    (result.suggestion !== null && typeof result.suggestion !== "string")
    || !Array.isArray(shortlist)
    || !shortlist.every((item) => item && typeof item === "object"
      && typeof (item as Record<string, unknown>).name === "string"
      && finiteNumber((item as Record<string, unknown>).probability))
    || (result.confidence !== null && !finiteNumber(result.confidence))
    || (result.neededProbability !== null && !finiteNumber(result.neededProbability))
    || typeof result.questionVersion !== "string"
    || typeof result.modelVersion !== "string"
    || !finiteNumber(result.latencyMs)
    || !usage || typeof usage !== "object"
    || !finiteNumber((usage as Record<string, unknown>).inputTokens)
    || !finiteNumber((usage as Record<string, unknown>).outputTokens)
    || typeof result.outcome !== "string"
    || !["hit", "miss", "coalesced"].includes(String(result.cache))
  ) throw Object.assign(new Error("Malformed skill suggestion plugin output"), { name: "InvalidResponseError" });
  return { contractVersion: SKILL_SUGGESTION_CONTRACT_VERSION, status: "observed",
    suggestion: result.suggestion as string | null,
    shortlist: shortlist as Array<{ name: string; probability: number }>,
    confidence: result.confidence as number | null,
    neededProbability: result.neededProbability as number | null,
    catalogVersion, questionVersion: result.questionVersion as string,
    modelVersion: result.modelVersion as string,
    latencyMs: result.latencyMs as number,
    usage: usage as { inputTokens: number; outputTokens: number },
    outcome: result.outcome as string, errorClass: null,
    cache: result.cache as string, skillActuallyLoaded: null };
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
    return parseResult(result, catalogVersion, started);
  } catch (error) { return failOpen(catalogVersion, started, error); }
}

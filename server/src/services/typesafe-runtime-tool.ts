import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, companySkills, type Db } from "@paperclipai/db";
import { z } from "zod";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { connectionIntentService } from "./connection-intents.js";
import { secretService } from "./secrets.js";

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(50_000), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValue).max(250), z.record(z.string().max(128), jsonValue),
]));
const structuredValue = z.union([
  z.string().min(1).max(50_000),
  z.array(jsonValue).max(250),
  z.record(z.string().max(128), jsonValue),
]);
const questionId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const noul = z.object({
  type: z.literal("noul"), instructions: structuredValue,
  criteria: z.object({ true: structuredValue.optional(), false: structuredValue.optional() }).strict().optional(),
}).strict();
const choice = z.object({
  type: z.literal("choice"), instructions: structuredValue,
  criteria: z.record(z.string().min(1).max(128), structuredValue.nullable())
    .refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255),
}).strict();
const score = z.object({
  type: z.literal("score"), instructions: structuredValue,
  criteria: z.array(structuredValue).min(2).max(10),
}).strict();
export const typeSafeJudgeInputSchema = z.object({
  state: structuredValue,
  model: z.string().min(1).max(80).default("jev-latest"),
  questions: z.record(questionId, z.discriminatedUnion("type", [choice, noul, score]))
    .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 32),
}).strict();

type Input = z.infer<typeof typeSafeJudgeInputSchema>;
type Failure = { ok: false; error: { code: string; retryable: boolean } };
type Binding = { type?: unknown; secretId?: unknown; version?: unknown };
type AgentSnapshot = { adapterConfig: Record<string, unknown>; updatedAt: Date } | null;
type SecretSnapshot = { value: string; secretVersionId: string };

function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function probability(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function distribution(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rows = value as Record<string, unknown>;
  if (Object.keys(rows).length !== keys.length || !keys.every((key) => probability(rows[key]))) return null;
  if (Math.abs(keys.reduce((sum, key) => sum + Number(rows[key]), 0) - 1) > 0.02) return null;
  return Object.fromEntries(keys.map((key) => [key, Number(rows[key])]));
}
function retryDelayMs(response: Response, now: number, attempt: number) {
  const milliseconds = response.headers.get("retry-after-ms");
  if (milliseconds !== null && milliseconds.trim() && Number.isFinite(Number(milliseconds)) && Number(milliseconds) >= 0) return Number(milliseconds);
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      if (seconds >= 0) return seconds * 1_000;
    } else {
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.max(0, date - now);
    }
  }
  return Math.min(500 * 2 ** attempt, 5_000);
}
function bindingOf(agent: AgentSnapshot): Binding | null {
  const binding = (agent?.adapterConfig.env as Record<string, unknown> | undefined)?.TYPESAFE_API_KEY as Binding | undefined;
  return binding?.type === "secret_ref" && typeof binding.secretId === "string" ? binding : null;
}
function configRevision(companyId: string, agentId: string, agent: AgentSnapshot, binding: Binding | null) {
  return agent && binding ? hash([companyId, agentId, agent.updatedAt.toISOString(), binding.secretId, binding.version ?? "latest"]) : "";
}

export function validateTypeSafeAnswers(input: Input, payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_response");
  const body = payload as Record<string, unknown>;
  const sourceAnswers = body.answers;
  const usage = body.usage as Record<string, unknown> | undefined;
  if (typeof body.model !== "string" || !sourceAnswers || typeof sourceAnswers !== "object" || Array.isArray(sourceAnswers)
    || !usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)
    || Number(usage.input_tokens) < 0 || Number(usage.output_tokens) < 0) throw new Error("invalid_response");
  const rows = sourceAnswers as Record<string, unknown>;
  // Aliases resolve to versioned IDs; an explicitly requested model must match.
  if (!body.model || (!["jev-latest", "jev-preview"].includes(input.model) && body.model !== input.model)) throw new Error("invalid_response");
  if (Object.keys(rows).length !== Object.keys(input.questions).length) throw new Error("invalid_response");
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = rows[id] as Record<string, unknown> | undefined;
    if (!answer || answer.type !== question.type) throw new Error("invalid_response");
    if (question.type === "noul") {
      if (!probability(answer.noul)) throw new Error("invalid_response");
      answers[id] = { type: "noul", noul: answer.noul };
    } else if (question.type === "choice") {
      const keys = Object.keys(question.criteria);
      const probabilities = distribution(answer.probabilities, keys);
      if (typeof answer.choice !== "string" || !keys.includes(answer.choice) || !probability(answer.confidence) || !probabilities) throw new Error("invalid_response");
      answers[id] = { type: "choice", choice: answer.choice, probabilities, confidence: answer.confidence };
    } else {
      const keys = question.criteria.map((_, index) => String(index));
      const probabilities = distribution(answer.probabilities, keys);
      const expectedLegend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), typeof criterion === "string" ? criterion : JSON.stringify(criterion)]));
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1
        || !probability(answer.confidence) || !probabilities || JSON.stringify(answer.legend) !== JSON.stringify(expectedLegend)) throw new Error("invalid_response");
      answers[id] = { type: "score", score: answer.score, legend: expectedLegend, probabilities, confidence: answer.confidence };
    }
  }
  return { model: body.model, answers, usage: { inputTokens: Number(usage.input_tokens), outputTokens: Number(usage.output_tokens) } };
}

export function renderTypeSafeResult(result: { answers: Record<string, unknown> }) {
  return Object.entries(result.answers).map(([id, raw]) => {
    const answer = raw as Record<string, unknown>;
    if (answer.type === "choice") return `${id}: ${String(answer.choice)}`;
    if (answer.type === "noul") return `${id}: ${Number(answer.noul).toFixed(3)}`;
    return `${id}: ${Number(answer.score).toFixed(3)}`;
  }).join("\n");
}

type Deps = {
  fetch?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number; sleep?: (ms: number) => Promise<void>;
  validateCapability?: (claims: RuntimeToolsTokenClaims) => Promise<unknown>;
  loadAgent?: (companyId: string, agentId: string) => Promise<AgentSnapshot>;
  resolveSecret?: (companyId: string, binding: Binding, claims: RuntimeToolsTokenClaims) => Promise<SecretSnapshot>;
  loadCatalogRevision?: (companyId: string) => Promise<string>;
};

export function typeSafeRuntimeToolService(db: Db, deps: Deps = {}) {
  const request = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const validateCapability = deps.validateCapability ?? ((claims: RuntimeToolsTokenClaims) => connectionIntentService(db).validate(claims));
  const loadAgent = deps.loadAgent ?? (async (companyId, agentId) => {
    const [agent] = await db.select({ adapterConfig: agents.adapterConfig, updatedAt: agents.updatedAt }).from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1);
    return agent ?? null;
  });
  const resolveSecret = deps.resolveSecret ?? (async (companyId, binding, claims) => secretService(db).resolveSecretValueWithMetadata(
    companyId, String(binding.secretId), typeof binding.version === "number" ? binding.version : "latest",
    { accessContext: { consumerType: "agent", consumerId: claims.sub, actorType: "agent", actorId: claims.sub,
      heartbeatRunId: claims.run_id, responsibleUserId: claims.responsible_user_id } },
  ));
  const loadCatalogRevision = deps.loadCatalogRevision ?? (async (companyId) => {
    const rows = await db.select({ id: companySkills.id, currentVersionId: companySkills.currentVersionId, updatedAt: companySkills.updatedAt })
      .from(companySkills).where(eq(companySkills.companyId, companyId)).orderBy(companySkills.id);
    return hash(rows.map((row) => [row.id, row.currentVersionId, row.updatedAt.toISOString()]));
  });

  return { async judge(claims: RuntimeToolsTokenClaims, raw: unknown): Promise<Failure | Record<string, unknown>> {
    // Keep REST, MCP, and native calls behind the same live-run authority. This
    // must precede agent/config/secret reads so a stale capability has no access
    // to company-scoped credential state.
    await validateCapability(claims);
    if (!/^(1|true|yes|on)$/i.test(env.PAPERCLIP_TYPESAFE_TOOL_ENABLED ?? "")) return { ok: false, error: { code: "disabled", retryable: false } };
    const input = typeSafeJudgeInputSchema.parse(raw);
    const agent = await loadAgent(claims.company_id, claims.sub);
    const binding = bindingOf(agent);
    if (!agent || !binding) return { ok: false, error: { code: "credential_denied", retryable: false } };
    const initialConfigRevision = configRevision(claims.company_id, claims.sub, agent, binding);
    const initialCatalogRevision = await loadCatalogRevision(claims.company_id);
    let apiKey = "";
    let initialSecretVersion = "";
    try {
      const secret = await resolveSecret(claims.company_id, binding, claims);
      apiKey = secret.value;
      initialSecretVersion = secret.secretVersionId;
    } catch { return { ok: false, error: { code: "credential_denied", retryable: false } }; }
    const started = now();
    const controller = new AbortController();
    const timeoutMs = Math.min(15_000, Math.max(1_000, Number(env.PAPERCLIP_TYPESAFE_TIMEOUT_MS) || 8_000));
    const deadline = started + timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const configurationIsCurrent = async () => {
      const freshAgent = await loadAgent(claims.company_id, claims.sub);
      const freshBinding = bindingOf(freshAgent);
      let freshSecretVersion = "";
      try { freshSecretVersion = (await resolveSecret(claims.company_id, freshBinding ?? {}, claims)).secretVersionId; }
      catch { return false; }
      const freshCatalogRevision = await loadCatalogRevision(claims.company_id);
      return configRevision(claims.company_id, claims.sub, freshAgent, freshBinding) === initialConfigRevision
        && freshSecretVersion === initialSecretVersion && freshCatalogRevision === initialCatalogRevision;
    };
    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          await validateCapability(claims);
          if (!await configurationIsCurrent()) return { ok: false, error: { code: "stale_configuration", retryable: true } };
          await validateCapability(claims);
        }
        if (controller.signal.aborted || now() >= deadline) return { ok: false, error: { code: "timeout", retryable: true } };
        try {
          response = await request("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ state: input.state, model: input.model, questions: input.questions }), signal: controller.signal });
        } catch (error) {
          return { ok: false, error: { code: (error as Error).name === "AbortError" ? "timeout" : "service_error", retryable: true } };
        }
        if (![429, 529].includes(response.status) || attempt === 1) break;
        const delay = retryDelayMs(response, now(), attempt);
        if (delay >= deadline - now()) break;
        await sleep(delay);
      }
      if (!response?.ok) return { ok: false, error: { code: response?.status === 429 ? "rate_limited" : response?.status === 529 ? "overloaded" : response?.status === 401 || response?.status === 403 ? "credential_denied" : "service_error", retryable: Boolean(response && [429, 529].includes(response.status)) } };
      // The provider may have completed after the heartbeat ended or its bound
      // identity changed. Discard its body before parsing or recording usage.
      await validateCapability(claims);
      let validated;
      try { validated = validateTypeSafeAnswers(input, await response.json()); }
      catch { return { ok: false, error: { code: "invalid_response", retryable: false } }; }
      if (!await configurationIsCurrent()) {
        return { ok: false, error: { code: "stale_configuration", retryable: true } };
      }
      await validateCapability(claims);
      return { ok: true, ...validated, rendered: renderTypeSafeResult(validated), latencyMs: Math.max(0, now() - started), metadata: {
        companyScoped: true, configRevision: initialConfigRevision, credentialVersion: hash(initialSecretVersion), catalogRevision: initialCatalogRevision,
        requestFingerprint: hash({ state: input.state, questions: input.questions }), questionSchema: hash(input.questions), model: input.model, cached: false,
      } };
    } finally { clearTimeout(timeout); apiKey = ""; }
  }};
}

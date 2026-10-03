import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { z } from "zod";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { secretService } from "./secrets.js";

const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string().max(50_000), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonValue).max(250), z.record(z.string().max(128), jsonValue),
]));
const instructions = z.union([z.string().min(1).max(8_000), z.array(jsonValue).max(100), z.record(z.string().max(128), jsonValue)]);
const questionId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const noul = z.object({ type: z.literal("noul"), instructions, criteria: z.object({ true: jsonValue.optional(), false: jsonValue.optional() }).strict().optional() }).strict();
const choice = z.object({ type: z.literal("choice"), instructions, criteria: z.record(z.string().min(1).max(128), jsonValue).refine((v) => Object.keys(v).length >= 2 && Object.keys(v).length <= 255) }).strict();
const score = z.object({ type: z.literal("score"), instructions, criteria: z.array(jsonValue).min(2).max(10) }).strict();
export const typeSafeJudgeInputSchema = z.object({
  state: jsonValue,
  model: z.string().min(1).max(80).default("jev-latest"),
  questions: z.record(questionId, z.discriminatedUnion("type", [choice, noul, score])).refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= 32),
  catalogRevision: z.string().max(128).optional(),
}).strict();

type Input = z.infer<typeof typeSafeJudgeInputSchema>;
type Failure = { ok: false; error: { code: string; retryable: boolean } };

function probability(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function distribution(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rows = value as Record<string, unknown>;
  return Object.keys(rows).length === keys.length && keys.every((key) => probability(rows[key])) && Math.abs(keys.reduce((sum, key) => sum + Number(rows[key]), 0) - 1) <= 0.02;
}
export function validateTypeSafeAnswers(input: Input, payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_response");
  const body = payload as Record<string, unknown>;
  const answers = body.answers;
  const usage = body.usage as Record<string, unknown> | undefined;
  if (typeof body.model !== "string" || !answers || typeof answers !== "object" || Array.isArray(answers) || !usage || !Number.isInteger(usage.input_tokens) || !Number.isInteger(usage.output_tokens)) throw new Error("invalid_response");
  const rows = answers as Record<string, unknown>;
  if (Object.keys(rows).length !== Object.keys(input.questions).length) throw new Error("invalid_response");
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = rows[id] as Record<string, unknown> | undefined;
    if (!answer || answer.type !== question.type) throw new Error("invalid_response");
    if (question.type === "noul" && !probability(answer.noul)) throw new Error("invalid_response");
    if (question.type === "choice") {
      const keys = Object.keys(question.criteria);
      if (typeof answer.choice !== "string" || !keys.includes(answer.choice) || !probability(answer.confidence) || !distribution(answer.probabilities, keys)) throw new Error("invalid_response");
    }
    if (question.type === "score") {
      const keys = question.criteria.map((_, index) => String(index));
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1 || !probability(answer.confidence) || !distribution(answer.probabilities, keys)) throw new Error("invalid_response");
    }
  }
  return { model: body.model, answers: rows, usage: { inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number } };
}

export function typeSafeRuntimeToolService(db: Db, deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const request = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  return { async judge(claims: RuntimeToolsTokenClaims, raw: unknown): Promise<Failure | Record<string, unknown>> {
    if (!/^(1|true|yes|on)$/i.test(env.PAPERCLIP_TYPESAFE_TOOL_ENABLED ?? "")) return { ok: false, error: { code: "disabled", retryable: false } };
    const input = typeSafeJudgeInputSchema.parse(raw);
    const [agent] = await db.select({ adapterConfig: agents.adapterConfig, updatedAt: agents.updatedAt }).from(agents).where(and(eq(agents.id, claims.sub), eq(agents.companyId, claims.company_id))).limit(1);
    const binding = (agent?.adapterConfig?.env as Record<string, unknown> | undefined)?.TYPESAFE_API_KEY as { type?: unknown; secretId?: unknown; version?: unknown } | undefined;
    if (!agent || binding?.type !== "secret_ref" || typeof binding.secretId !== "string") return { ok: false, error: { code: "credential_denied", retryable: false } };
    const revision = createHash("sha256").update(JSON.stringify([claims.company_id, claims.sub, agent.updatedAt.toISOString(), binding.secretId, binding.version ?? "latest"])).digest("hex");
    let apiKey: string;
    let secretVersionId: string;
    try {
      ({ value: apiKey, secretVersionId } = await secretService(db).resolveSecretValueWithMetadata(claims.company_id, binding.secretId, typeof binding.version === "number" ? binding.version : "latest", { accessContext: { consumerType: "agent", consumerId: claims.sub, actorType: "agent", actorId: claims.sub, heartbeatRunId: claims.run_id, responsibleUserId: claims.responsible_user_id } }));
    } catch { return { ok: false, error: { code: "credential_denied", retryable: false } }; }
    const started = now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(15_000, Math.max(1_000, Number(env.PAPERCLIP_TYPESAFE_TIMEOUT_MS) || 8_000)));
    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { response = await request("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(input), signal: controller.signal }); }
        catch (error) { if ((error as Error).name === "AbortError") return { ok: false, error: { code: "timeout", retryable: true } }; return { ok: false, error: { code: "service_error", retryable: true } }; }
        if (![429, 529].includes(response.status) || attempt === 1) break;
        await sleep(100);
      }
      if (!response?.ok) return { ok: false, error: { code: response?.status === 429 ? "rate_limited" : response?.status === 529 ? "overloaded" : response?.status === 401 || response?.status === 403 ? "credential_denied" : "service_error", retryable: Boolean(response && [429, 529].includes(response.status)) } };
      let validated;
      try { validated = validateTypeSafeAnswers(input, await response.json()); } catch { return { ok: false, error: { code: "invalid_response", retryable: false } }; }
      const [fresh] = await db.select({ adapterConfig: agents.adapterConfig, updatedAt: agents.updatedAt }).from(agents).where(and(eq(agents.id, claims.sub), eq(agents.companyId, claims.company_id))).limit(1);
      const freshBinding = (fresh?.adapterConfig?.env as Record<string, unknown> | undefined)?.TYPESAFE_API_KEY as Record<string, unknown> | undefined;
      const freshRevision = fresh && freshBinding ? createHash("sha256").update(JSON.stringify([claims.company_id, claims.sub, fresh.updatedAt.toISOString(), freshBinding.secretId, freshBinding.version ?? "latest"])).digest("hex") : "";
      if (freshRevision !== revision) return { ok: false, error: { code: "stale_configuration", retryable: true } };
      return { ok: true, ...validated, latencyMs: Math.max(0, now() - started), metadata: { companyScoped: true, configRevision: revision, credentialVersion: createHash("sha256").update(secretVersionId).digest("hex"), catalogRevision: input.catalogRevision ?? null, requestFingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex"), cached: false } };
    } finally { clearTimeout(timeout); apiKey = ""; }
  }};
}

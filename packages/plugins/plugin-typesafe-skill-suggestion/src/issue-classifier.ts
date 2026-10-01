import { createHash } from "node:crypto";
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { JsonValue } from "@typesafe-ai/sdk";

export const ISSUE_CLASSIFICATION_CONTRACT_VERSION = "issue-classification-shadow.v1.1.0";
export const ISSUE_CLASSIFICATION_QUESTION_VERSION = "occ-internal-issue-triage.2026-10-01";
export const ISSUE_CLASSIFICATION_MODEL = "jev-1.13.0";
export const ISSUE_CLASSIFICATION_STATE_KEY = "recommendation-v1.1.0";
export const WORK_TYPES = ["bug_fix", "feature_build", "report_or_dashboard_build", "reporting_analysis", "governance_review", "no_match"] as const;
export type WorkType = typeof WORK_TYPES[number];

export type IssueClassificationInput = {
  issueId: string;
  title: string;
  summary: string;
  inputRevision: string;
  explicitlyAssigned: boolean;
  mandatoryPolicyRule: string | null;
  humanAuthorityRule: string | null;
};

export type IssueClassificationRecommendation = {
  contractVersion: typeof ISSUE_CLASSIFICATION_CONTRACT_VERSION;
  questionVersion: typeof ISSUE_CLASSIFICATION_QUESTION_VERSION;
  requestedModel: typeof ISSUE_CLASSIFICATION_MODEL;
  resolvedModel: string | null;
  inputRevision: string;
  label: WorkType | null;
  probabilities: Partial<Record<WorkType, number>>;
  confidence: number | null;
  requiresHumanDecisionProbability: number | null;
  requiresHumanDecision: boolean;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  cache: "hit" | "miss" | "coalesced";
  fallbackReason: string | null;
  actualClassification: WorkType | null;
  reviewerOverride: WorkType | null;
};

type ClassificationClient = {
  classify(state: Record<string, JsonValue>): Promise<{
    model: string;
    label: string;
    confidence: number;
    probabilities: Record<string, number>;
    requiresHumanDecision: number;
    usage: { input_tokens: number; output_tokens: number };
  }>;
};

const CRITICAL_KEY = /(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_ID = /\b(?:[a-f0-9]{24,}|\d{9,})\b/gi;

export function sanitizeIssueText(value: string, limit: number): string {
  return value.normalize("NFKC").replace(CRITICAL_KEY, "$1=[redacted]").replace(EMAIL, "[email]")
    .replace(LONG_ID, "[id]").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function issueInputRevision(title: string, summary: string): string {
  return createHash("sha256").update(JSON.stringify({ title: sanitizeIssueText(title, 200), summary: sanitizeIssueText(summary, 500) })).digest("hex");
}
export function isCurrentIssueRevision(inputRevision: string, title: string, summary: string): boolean {
  return issueInputRevision(title, summary) === inputRevision;
}

export function createIssueClassificationClient(apiKey: string, timeoutMs: number, maxRetries: number): ClassificationClient {
  const client = new TypeSafeClient({ apiKey, defaultModel: ISSUE_CLASSIFICATION_MODEL, timeout: timeoutMs,
    retry: { maxRetries }, logLevel: "warn" });
  return {
    async classify(state) {
      const result = await client.systemOne({ model: ISSUE_CLASSIFICATION_MODEL, state, questions: {
        work_type: choice("Classify the issue from `title` and `summary`. Building or automating a reusable report/dashboard is report_or_dashboard_build; producing, measuring, summarizing, or analyzing a report without a new reusable artifact is reporting_analysis.", {
            bug_fix: "Repair a defect or regression in existing functionality.",
            feature_build: "Implement a new capability, feature, or integration, excluding report/dashboard builds.",
            report_or_dashboard_build: "Build an automated reusable report, dashboard, reporting pipeline, or scheduled reporting job.",
            reporting_analysis: "Produce a measurement, inventory, summary, analysis, or report without new reusable software.",
            governance_review: "Perform an approval, policy, review gate, decision, audit, or compliance sign-off.",
            no_match: "None applies or the text does not determine the type.",
          }),
        requires_human_decision: noul("Does this issue require a reserved human decision, approval, authority, credential, spend, legal judgment, production action, or policy choice?", { true: "A human authority must decide or act.", false: "An agent may execute within existing authority." }),
      }});
      return { model: result.model, label: result.answers.work_type.choice, confidence: result.answers.work_type.confidence,
        probabilities: result.answers.work_type.probabilities, requiresHumanDecision: result.answers.requires_human_decision.noul,
        usage: result.usage };
    },
  };
}

function empty(input: IssueClassificationInput, started: number, fallbackReason: string): IssueClassificationRecommendation {
  return { contractVersion: ISSUE_CLASSIFICATION_CONTRACT_VERSION, questionVersion: ISSUE_CLASSIFICATION_QUESTION_VERSION,
    requestedModel: ISSUE_CLASSIFICATION_MODEL, resolvedModel: null, inputRevision: input.inputRevision, label: null,
    probabilities: {}, confidence: null, requiresHumanDecisionProbability: null,
    requiresHumanDecision: Boolean(input.humanAuthorityRule), latencyMs: Math.round(performance.now() - started),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, cache: "miss", fallbackReason,
    actualClassification: null, reviewerOverride: null };
}

function validate(result: Awaited<ReturnType<ClassificationClient["classify"]>>) {
  if (!WORK_TYPES.includes(result.label as WorkType) || !Number.isFinite(result.confidence)
    || !Number.isFinite(result.requiresHumanDecision) || !result.model
    || !Number.isFinite(result.usage.input_tokens) || !Number.isFinite(result.usage.output_tokens)) {
    throw Object.assign(new Error("Invalid issue classification response"), { name: "InvalidResponseError" });
  }
  for (const [label, probability] of Object.entries(result.probabilities)) {
    if (!WORK_TYPES.includes(label as WorkType) || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw Object.assign(new Error("Invalid issue classification probabilities"), { name: "InvalidResponseError" });
    }
  }
}

const cache = new Map<string, { expires: number; value: IssueClassificationRecommendation }>();
const inflight = new Map<string, Promise<IssueClassificationRecommendation>>();
export function clearIssueClassificationCache() { cache.clear(); inflight.clear(); }
function cacheKey(input: IssueClassificationInput) {
  return createHash("sha256").update(JSON.stringify({ revision: input.inputRevision, contract: ISSUE_CLASSIFICATION_CONTRACT_VERSION,
    question: ISSUE_CLASSIFICATION_QUESTION_VERSION, model: ISSUE_CLASSIFICATION_MODEL })).digest("hex");
}

export async function classifyIssue(input: IssueClassificationInput, client: ClassificationClient): Promise<IssueClassificationRecommendation> {
  const started = performance.now();
  if (!sanitizeIssueText(input.title, 200) && !sanitizeIssueText(input.summary, 500)) return empty(input, started, "missing_candidates");
  if (input.explicitlyAssigned) return empty(input, started, "explicit_assignment_precedence");
  if (input.mandatoryPolicyRule) return empty(input, started, `mandatory_policy_precedence:${input.mandatoryPolicyRule}`);
  if (input.humanAuthorityRule) return empty(input, started, `human_authority_precedence:${input.humanAuthorityRule}`);
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cache: "hit", latencyMs: Math.round(performance.now() - started),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
  const pending = inflight.get(key);
  if (pending) return { ...(await pending), cache: "coalesced", latencyMs: Math.round(performance.now() - started),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
  const work = (async () => {
    try {
      const result = await client.classify({ title: sanitizeIssueText(input.title, 200), summary: sanitizeIssueText(input.summary, 500) });
      validate(result);
      if (result.confidence < 0.6) return empty(input, started, "low_confidence");
      const usage = { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
        estimatedCostUsd: Number(((result.usage.input_tokens * 0.042) / 1_000_000).toFixed(9)) };
      const value: IssueClassificationRecommendation = {
        contractVersion: ISSUE_CLASSIFICATION_CONTRACT_VERSION, questionVersion: ISSUE_CLASSIFICATION_QUESTION_VERSION,
        requestedModel: ISSUE_CLASSIFICATION_MODEL, resolvedModel: result.model, inputRevision: input.inputRevision,
        label: result.label as WorkType, probabilities: result.probabilities as Partial<Record<WorkType, number>>,
        confidence: result.confidence, requiresHumanDecisionProbability: result.requiresHumanDecision,
        requiresHumanDecision: result.requiresHumanDecision >= 0.5,
        latencyMs: Math.round(performance.now() - started), usage, cache: "miss", fallbackReason: null,
        actualClassification: null, reviewerOverride: null,
      };
      cache.set(key, { expires: Date.now() + 300_000, value });
      return value;
    } catch (error) {
      return empty(input, started, error instanceof Error ? error.name : "UnknownError");
    }
  })();
  inflight.set(key, work);
  try { return await work; } finally { inflight.delete(key); }
}

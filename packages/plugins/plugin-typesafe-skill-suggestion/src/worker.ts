import { definePlugin, runWorker, type EnvSecretRefBinding, type PluginEvent } from "@paperclipai/plugin-sdk";
import { CONTRACT_VERSION, DEFAULT_MODEL_VERSION, QUESTION_VERSION, createDecisionClient, requestFingerprint, suggest, type DecisionClient, type SuggestionRequest } from "./selector.js";
import { classifyIssue, createIssueClassificationClient, ISSUE_CLASSIFICATION_STATE_KEY, isCurrentIssueRevision, issueInputRevision,
  type ClassificationClient, type IssueClassificationRecommendation, type IssueClassificationRevisionState, type WorkType } from "./issue-classifier.js";

function configuredNumber(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" ? Math.min(max, Math.max(min, value)) : fallback;
}

function mandatoryRule(title: string, summary: string): string | null {
  const text = `${title} ${summary}`.toLowerCase();
  if (/\b(security incident|credential rotation|legal hold|gate a|gate b)\b/.test(text)) return "reserved_policy_surface";
  return null;
}
function humanAuthorityRule(title: string, summary: string): string | null {
  const text = `${title} ${summary}`.toLowerCase();
  if (/\b(board approval|human approval|approve payment|production deploy|credential change|legal decision)\b/.test(text)) return "reserved_human_authority";
  return null;
}

type SkillSuggestionPluginOptions = {
  issueClassificationClientFactory?: (apiKey: string, timeoutMs: number, maxRetries: number) => ClassificationClient;
  suggestionClientFactory?: (apiKey: string, model: string, timeoutMs: number, maxRetries: number) => DecisionClient;
};

function mandatorySkillNames(event: PluginEvent): string[] | null {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  if (payload.mandatorySkillNamesAvailable !== true || !Array.isArray(payload.mandatorySkillNames)) return null;
  if (!payload.mandatorySkillNames.every((name) => typeof name === "string")) return null;
  return [...new Set(payload.mandatorySkillNames.map((name) => name.trim()).filter(Boolean))];
}

function revisionState(issue: { assigneeAgentId?: string | null; assigneeUserId?: string | null }, title: string, summary: string,
  requiredSkills: string[]): IssueClassificationRevisionState {
  return {
    explicitlyAssigned: Boolean(issue.assigneeAgentId || issue.assigneeUserId),
    mandatorySkillNames: requiredSkills,
    mandatoryPolicyRule: mandatoryRule(title, summary),
    humanAuthorityRule: humanAuthorityRule(title, summary),
  };
}

export function createSkillSuggestionPlugin(options: SkillSuggestionPluginOptions = {}) {
  const classificationClientFactory = options.issueClassificationClientFactory ?? createIssueClassificationClient;
  const suggestionClientFactory = options.suggestionClientFactory ?? createDecisionClient;
  return definePlugin({
    async setup(ctx) {
      ctx.actions.register("skill-suggestion-shadow-v1", async (params, actionContext) => {
        const companyId = actionContext.companyId;
        if (!companyId) throw new Error("company scope is required");
        const initialConfig = await ctx.config.getWithRevision(companyId);
        const config = initialConfig.value;
        const input = params as Record<string, unknown>;
        const mode = input.mode === "active" ? "active" : "shadow";
        if (config.enabled !== true || (mode === "active" && config.activeEnabled !== true)) return { contractVersion: CONTRACT_VERSION, disabled: true };
        const ref = config.apiKeyRef as EnvSecretRefBinding | undefined;
        if (!ref || ref.type !== "secret_ref") throw new Error("managed TypeSafe secret reference is required");
        const credential = await ctx.secrets.resolveWithMetadata(ref, { companyId, configPath: "apiKeyRef" });
        const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : DEFAULT_MODEL_VERSION;
        const timeoutMs = typeof config.timeoutMs === "number" ? Math.min(15_000, Math.max(1_000, config.timeoutMs)) : 5_000;
        const maxRetries = typeof config.maxRetries === "number" ? Math.min(2, Math.max(0, config.maxRetries)) : 1;
        const request = typeof input.request === "string" ? input.request : "";
        const suggestionRequest: SuggestionRequest = {
          identity: { companyId, bindingId: credential.bindingId, bindingRevision: credential.bindingRevision,
            secretVersionId: credential.secretVersionId, configRevision: initialConfig.revision,
            catalogRevision: String(input.catalogRevision ?? ""), requestFingerprint: requestFingerprint(request),
            questionVersion: QUESTION_VERSION, contractVersion: CONTRACT_VERSION, model },
          request, skills: Array.isArray(input.skills) ? input.skills as SuggestionRequest["skills"] : [],
          explicitSkillIds: Array.isArray(input.explicitSkillIds) ? input.explicitSkillIds as string[] : [],
          mandatorySkillIds: Array.isArray(input.mandatorySkillIds) ? input.mandatorySkillIds as string[] : [],
          minNeededProbability: typeof config.minNeededProbability === "number" ? config.minNeededProbability : undefined,
          minAcceptableProbability: typeof config.minAcceptableProbability === "number" ? config.minAcceptableProbability : undefined,
          minConfidence: typeof config.minConfidence === "number" ? config.minConfidence : undefined,
          cacheTtlMs: typeof config.cacheTtlMs === "number" ? config.cacheTtlMs : undefined,
          cacheMaxEntries: typeof config.cacheMaxEntries === "number" ? config.cacheMaxEntries : undefined,
        };
        const result = await suggest(suggestionRequest, suggestionClientFactory(credential.value, model, timeoutMs, maxRetries));
        const [freshConfig, freshCredential] = await Promise.all([
          ctx.config.getWithRevision(companyId), ctx.secrets.resolveWithMetadata(ref, { companyId, configPath: "apiKeyRef" }),
        ]);
        if (freshConfig.revision !== result.identity.configRevision || freshCredential.bindingId !== result.identity.bindingId ||
          freshCredential.bindingRevision !== result.identity.bindingRevision || freshCredential.secretVersionId !== result.identity.secretVersionId) {
          throw Object.assign(new Error("fresh state changed"), { name: "StaleStateError" });
        }
        return result;
      });
      ctx.actions.register("skill-load-attribution-v1", async () => ({ accepted: true }));
      ctx.actions.register("issue-classification-attribution-v1", async (params, actionContext) => {
        const companyId = actionContext.companyId;
        const issueId = typeof params.issueId === "string" ? params.issueId : "";
        if (!companyId || !issueId) throw new Error("companyId and issueId are required");
        const current = await ctx.state.get({ scopeKind: "issue", scopeId: issueId, namespace: "issue-classification-shadow", stateKey: ISSUE_CLASSIFICATION_STATE_KEY });
        if (!current || typeof current !== "object") return { accepted: false, reason: "missing_recommendation" };
        const labels = ["bug_fix", "feature_build", "report_or_dashboard_build", "reporting_analysis", "governance_review", "no_match"];
        const actual = labels.includes(String(params.actualClassification)) ? params.actualClassification as WorkType : null;
        const override = labels.includes(String(params.reviewerOverride)) ? params.reviewerOverride as WorkType : null;
        await ctx.state.set({ scopeKind: "issue", scopeId: issueId, namespace: "issue-classification-shadow", stateKey: ISSUE_CLASSIFICATION_STATE_KEY },
          { ...(current as IssueClassificationRecommendation), actualClassification: actual, reviewerOverride: override });
        return { accepted: true };
      });

      const observe = async (event: PluginEvent) => {
        const issueId = event.entityId;
        if (!issueId) return;
        const config = await ctx.config.get(event.companyId);
        if (config.issueClassificationShadowEnabled !== true || config.issueClassificationKillSwitch !== false) return;
        const issue = await ctx.issues.get(issueId, event.companyId);
        if (!issue) return;
        const summary = issue.description ?? "";
        const requiredSkills = mandatorySkillNames(event);
        if (!requiredSkills) return;
        const guards = revisionState(issue, issue.title, summary, requiredSkills);
        const revision = issueInputRevision(issue.title, summary, guards);
        const ref = config.apiKeyRef as EnvSecretRefBinding | undefined;
        if (!ref || ref.type !== "secret_ref") return;
        const apiKey = await ctx.secrets.resolve(ref, { companyId: event.companyId, configPath: "apiKeyRef" });
        const recommendation = await classifyIssue({ issueId, title: issue.title, summary, inputRevision: revision,
          explicitlyAssigned: guards.explicitlyAssigned ?? false, mandatorySkillNames: requiredSkills,
          mandatoryPolicyRule: guards.mandatoryPolicyRule ?? null, humanAuthorityRule: guards.humanAuthorityRule ?? null },
          classificationClientFactory(apiKey, configuredNumber(config.timeoutMs, 5_000, 1_000, 15_000), configuredNumber(config.maxRetries, 1, 0, 2)));
        const fresh = await ctx.issues.get(issueId, event.companyId);
        if (!fresh) return;
        const freshSummary = fresh.description ?? "";
        const freshGuards = revisionState(fresh, fresh.title, freshSummary, requiredSkills);
        if (!isCurrentIssueRevision(revision, fresh.title, freshSummary, freshGuards)) return;
        await ctx.state.set({ scopeKind: "issue", scopeId: issueId, namespace: "issue-classification-shadow", stateKey: ISSUE_CLASSIFICATION_STATE_KEY }, recommendation);
      };
      ctx.events.on("issue.created", observe);
      ctx.events.on("issue.updated", observe);
    },
    async onHealth() { return { status: "ok", message: "TypeSafe skill suggestion shadow worker is ready" }; },
  });
}
const plugin = createSkillSuggestionPlugin();
export default plugin;
runWorker(plugin, import.meta.url);

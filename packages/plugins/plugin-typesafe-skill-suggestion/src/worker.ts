import { definePlugin, runWorker, type EnvSecretRefBinding } from "@paperclipai/plugin-sdk";
import { CONTRACT_VERSION, createDecisionClient, suggest, type SuggestionRequest } from "./selector.js";

export function createSkillSuggestionPlugin() {
  return definePlugin({
    async setup(ctx) {
      ctx.actions.register("skill-suggestion-shadow-v1", async (params, actionContext) => {
        const companyId = actionContext.companyId;
        if (!companyId) throw new Error("company scope is required");
        const config = await ctx.config.get(companyId);
        if (config.enabled !== true) return { contractVersion: CONTRACT_VERSION, disabled: true };
        const ref = config.apiKeyRef as EnvSecretRefBinding | undefined;
        if (!ref || ref.type !== "secret_ref") throw new Error("managed TypeSafe secret reference is required");
        const apiKey = await ctx.secrets.resolve(ref, { companyId, configPath: "apiKeyRef" });
        const timeoutMs = typeof config.timeoutMs === "number" ? Math.min(15_000, Math.max(1_000, config.timeoutMs)) : 5_000;
        const maxRetries = typeof config.maxRetries === "number" ? Math.min(2, Math.max(0, config.maxRetries)) : 1;
        return suggest(params as unknown as SuggestionRequest, createDecisionClient(apiKey, timeoutMs, maxRetries));
      });
      ctx.actions.register("skill-load-attribution-v1", async () => ({ accepted: true }));
    },
    async onHealth() { return { status: "ok", message: "TypeSafe skill suggestion shadow worker is ready" }; },
  });
}
const plugin = createSkillSuggestionPlugin();
export default plugin;
runWorker(plugin, import.meta.url);

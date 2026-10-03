import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { renderPaperclipSkillRelevanceAdvisory } from "@paperclipai/adapter-utils/server-utils";
import manifest from "../../../packages/plugins/plugin-typesafe-skill-suggestion/src/manifest.js";
import { createSkillSuggestionPlugin } from "../../../packages/plugins/plugin-typesafe-skill-suggestion/src/worker.js";
import type { DecisionClient } from "../../../packages/plugins/plugin-typesafe-skill-suggestion/src/selector.js";
import { advisorySkillContext, observeSkillSuggestion } from "../services/skill-suggestion-shadow.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const pluginId = "plugin-typesafe-suggestion";
const skills = [{ key: "typesafe-ai", runtimeName: "typesafe-ai", source: "/missing", versionId: "v1", currentVersionId: "v1" }];
const activeEnv = {
  PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE: "true",
  PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: pluginId,
};

function decisionClient(): DecisionClient {
  const response = {
    model: "jev-1.13.0",
    id: "typesafe-ai",
    confidence: 1,
    probabilities: { "typesafe-ai": 1 },
    gate: 1,
    usage: { input_tokens: 2, output_tokens: 1 },
  };
  return { rank: vi.fn(async () => response), verify: vi.fn(async () => response) };
}

async function runtime(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  const plugin = createSkillSuggestionPlugin({ suggestionClientFactory: () => decisionClient() });
  await plugin.definition.setup(harness.ctx);
  const workerManager = {
    isRunning: (id: string) => id === pluginId,
    call: async (_id: string, _method: string, input: Record<string, unknown>) => {
      const params = input.params as Record<string, unknown>;
      return harness.performAction(String(input.key), params, { companyId: String(input.companyId) });
    },
  };
  return { harness, workerManager };
}

async function observe(env: Record<string, string | undefined>, workerManager?: Awaited<ReturnType<typeof runtime>>["workerManager"]) {
  return observeSkillSuggestion({
    env,
    workerManager: workerManager as never,
    companyId,
    request: "Use semantic judgment for this task",
    skills,
    readFreshSkills: async () => skills,
    explicitSkillIds: [],
    mandatorySkillIds: [],
  });
}

describe("TypeSafe active advisory rollout contract", () => {
  it("starts at the real plugin action and reaches the agent-visible sanitized renderer", async () => {
    const { workerManager } = await runtime({
      enabled: true,
      activeEnabled: true,
      apiKeyRef: { type: "secret_ref", secretId: "typesafe-test" },
    });
    const observation = await observe(activeEnv, workerManager);
    const rendered = renderPaperclipSkillRelevanceAdvisory(advisorySkillContext(observation));
    expect(observation).toMatchObject({ status: "observed", outcome: "suggested", active: true, suggestion: "typesafe-ai" });
    expect(rendered).toContain("<skill_id>typesafe-ai</skill_id>");
    expect(rendered).toContain("explicit user-selected and mandatory skill rules take precedence");
    expect(rendered).not.toContain("Use semantic judgment");
    expect(JSON.stringify(observation)).not.toContain("resolved:typesafe-test");
  });

  it.each([
    ["disabled", {}, "disabled"],
    ["tool only", { PAPERCLIP_TYPESAFE_TOOL_ENABLED: "true", PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: pluginId }, "disabled"],
    ["unused legacy advisory flag", { PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ENABLED: "true", PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: pluginId }, "disabled"],
    ["missing plugin id", { PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE: "true" }, "failed_open"],
  ])("keeps %s independent", async (_label, env, status) => {
    expect((await observe(env)).status).toBe(status);
  });

  it("keeps shadow-only advisory-free and lets active win when both host flags are enabled", async () => {
    const { workerManager } = await runtime({ enabled: true, activeEnabled: true, apiKeyRef: { type: "secret_ref", secretId: "typesafe-test" } });
    const shadow = await observe({ PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW: "true", PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: pluginId }, workerManager);
    expect(shadow.active).toBe(false);
    expect(advisorySkillContext(shadow)).toBeNull();
    const both = await observe({ ...activeEnv, PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW: "true" }, workerManager);
    expect(both.active).toBe(true);
    expect(advisorySkillContext(both)).not.toBeNull();
  });

  it.each([
    ["plugin disabled", { enabled: false, activeEnabled: true }],
    ["active config disabled", { enabled: true, activeEnabled: false }],
  ])("honors %s", async (_label, flags) => {
    const { workerManager } = await runtime({ ...flags, apiKeyRef: { type: "secret_ref", secretId: "typesafe-test" } });
    expect(await observe(activeEnv, workerManager)).toMatchObject({ status: "disabled", active: true });
  });

  it("fails open for a stopped worker, wrong-company response, and stale config", async () => {
    expect(await observe(activeEnv, { isRunning: () => false, call: vi.fn() } as never)).toMatchObject({ status: "failed_open", errorClass: "Error" });
    const wrongCompany = { isRunning: () => true, call: vi.fn(async () => ({
      identity: { companyId: "other-company", catalogRevision: "wrong", contractVersion: "skill-suggestion-active.v2" },
      suggestion: "typesafe-ai", shortlist: [], confidence: 1, neededProbability: 1, outcome: "suggested",
    })) };
    expect(await observe(activeEnv, wrongCompany as never)).toMatchObject({ status: "failed_open", errorClass: "InvalidResponseError" });

    const state = await runtime({ enabled: true, activeEnabled: true, apiKeyRef: { type: "secret_ref", secretId: "typesafe-test" } });
    let reads = 0;
    state.harness.ctx.config.getWithRevision = async () => ({
      value: { enabled: true, activeEnabled: true, apiKeyRef: { type: "secret_ref", secretId: "typesafe-test" } },
      revision: ++reads === 1 ? "config:1" : "config:2",
    });
    expect(await observe(activeEnv, state.workerManager)).toMatchObject({ status: "failed_open", errorClass: "StaleStateError" });
  });

  it("preserves mandatory and explicit precedence at the host boundary", async () => {
    const { workerManager } = await runtime({ enabled: true, activeEnabled: true, apiKeyRef: { type: "secret_ref", secretId: "typesafe-test" } });
    for (const precedence of [{ explicitSkillIds: ["typesafe-ai"], mandatorySkillIds: [] }, { explicitSkillIds: [], mandatorySkillIds: ["paperclip"] }]) {
      const result = await observeSkillSuggestion({ env: activeEnv, workerManager: workerManager as never, companyId,
        request: "Use semantic judgment", skills, readFreshSkills: async () => skills, ...precedence });
      expect(result).toMatchObject({ outcome: "deterministic_precedence", suggestion: null, active: false });
      expect(advisorySkillContext(result)).toBeNull();
    }
  });
});

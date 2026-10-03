import { describe, expect, it, vi } from "vitest";
import { advisorySkillContext, catalogRevision, observeSkillSuggestion } from "../services/skill-suggestion-shadow.js";

const skills = [{ key: "php", runtimeName: "php", source: "/missing", versionId: "v1", currentVersionId: "v1" }];
const base = { companyId: "company-1", request: "ambiguous request", skills, explicitSkillIds: [], mandatorySkillIds: [] };
const validResult = () => ({
  identity: { companyId: "company-1", catalogRevision: catalogRevision(skills), contractVersion: "skill-suggestion-active.v2", questionVersion: "q1", model: "jev-1.13.0" },
  suggestion: "php", shortlist: [{ id: "php", probability: 0.9 }], confidence: 0.8, neededProbability: 0.9,
  latencyMs: 5, usage: { inputTokens: 2, outputTokens: 1 }, outcome: "suggested", cache: "miss",
});
const env = { PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE: "true", PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: "plugin-1" };

describe("skill suggestion host", () => {
  it("is disabled by default", async () => expect((await observeSkillSuggestion({ ...base, env: {} })).status).toBe("disabled"));
  it.each(["TimeoutError", "RateLimitError", "PermissionDeniedError", "InvalidResponseError", "ConnectionError"]) ("fails open on %s", async (name) => {
    const error = Object.assign(new Error(name), { name });
    const workerManager = { isRunning: () => true, call: vi.fn().mockRejectedValue(error) };
    const result = await observeSkillSuggestion({ ...base, env, workerManager: workerManager as never });
    expect(result).toMatchObject({ status: "failed_open", errorClass: name, suggestion: null });
  });
  it("revalidates catalog freshness and fails open on revision drift", async () => {
    const workerManager = { isRunning: () => true, call: vi.fn().mockResolvedValue(validResult()) };
    const result = await observeSkillSuggestion({ ...base, env, workerManager: workerManager as never,
      readFreshSkills: async () => [{ ...skills[0]!, currentVersionId: "v2" }] });
    expect(result).toMatchObject({ status: "failed_open", errorClass: "StaleCatalogError", suggestion: null });
  });
  it("validates catalog membership before producing a sanitized advisory", async () => {
    const workerManager = { isRunning: () => true, call: vi.fn().mockResolvedValue(validResult()) };
    const result = await observeSkillSuggestion({ ...base, env, workerManager: workerManager as never, readFreshSkills: async () => skills });
    expect(advisorySkillContext(result)).toEqual({ kind: "skill_relevance_advisory_v1", skillId: "php",
      instruction: "This installed skill appears relevant. Treat this as advisory only; explicit user-selected and mandatory skill rules take precedence." });
    expect(JSON.stringify(advisorySkillContext(result))).not.toContain("ambiguous request");
  });
  it("keeps deterministic explicit precedence authoritative", async () => {
    const workerManager = { isRunning: () => true, call: vi.fn().mockResolvedValue(validResult()) };
    const result = await observeSkillSuggestion({ ...base, explicitSkillIds: ["php"], env, workerManager: workerManager as never, readFreshSkills: async () => skills });
    expect(result).toMatchObject({ outcome: "deterministic_precedence", suggestion: null, active: false });
    expect(advisorySkillContext(result)).toBeNull();
  });
  it("rejects malformed non-finite telemetry", async () => {
    const workerManager = { isRunning: () => true, call: vi.fn().mockResolvedValue({ ...validResult(), confidence: Number.NaN }) };
    const result = await observeSkillSuggestion({ ...base, env, workerManager: workerManager as never });
    expect(result).toMatchObject({ status: "failed_open", errorClass: "InvalidResponseError" });
  });
  it("fails open on malformed plugin output", async () => {
    const workerManager = { isRunning: () => true, call: vi.fn().mockResolvedValue({ suggestion: 42 }) };
    const result = await observeSkillSuggestion({ ...base,
      env: { PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW: "true", PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: "plugin-1" },
      workerManager: workerManager as never });
    expect(result).toMatchObject({ status: "failed_open", errorClass: "InvalidResponseError", suggestion: null });
  });
  it("never applies a valid shadow suggestion", async () => {
    const workerManager = { isRunning: () => true, call: vi.fn().mockResolvedValue({
      suggestion: "php", shortlist: [{ name: "php", probability: 0.9 }], confidence: 0.8,
      neededProbability: 0.9, questionVersion: "q1", modelVersion: "jev", latencyMs: 12,
      usage: { inputTokens: 3, outputTokens: 1 }, outcome: "suggested", cache: "miss",
    }) };
    const result = await observeSkillSuggestion({ ...base,
      env: { PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW: "true", PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: "plugin-1" },
      workerManager: workerManager as never });
    expect(result).toMatchObject({ status: "observed", suggestion: "php", skillActuallyLoaded: null });
  });
});

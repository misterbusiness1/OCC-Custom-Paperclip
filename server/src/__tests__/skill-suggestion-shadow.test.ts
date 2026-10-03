import { describe, expect, it, vi } from "vitest";
import { observeSkillSuggestion } from "../services/skill-suggestion-shadow.js";

const base = { companyId: "company-1", request: "ambiguous request", skills: [], explicitSkillNames: [], mandatorySkillNames: [] };

describe("skill suggestion shadow host", () => {
  it("is disabled by default", async () => {
    const result = await observeSkillSuggestion({ ...base, env: {} });
    expect(result.status).toBe("disabled");
  });
  it.each(["TimeoutError", "RateLimitError", "InvalidResponseError", "ConnectionError"])("fails open on %s", async (name) => {
    const error = Object.assign(new Error(name), { name });
    const workerManager = { isRunning: () => true, call: vi.fn().mockRejectedValue(error) };
    const result = await observeSkillSuggestion({ ...base,
      env: { PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW: "true", PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID: "plugin-1" },
      workerManager: workerManager as never });
    expect(result.status).toBe("failed_open");
    expect(result.errorClass).toBe(name);
    expect(result.suggestion).toBeNull();
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

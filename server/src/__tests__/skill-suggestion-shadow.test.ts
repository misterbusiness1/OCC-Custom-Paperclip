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
});

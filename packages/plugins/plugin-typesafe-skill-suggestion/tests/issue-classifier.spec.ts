import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyIssue, clearIssueClassificationCache, isCurrentIssueRevision, issueInputRevision, sanitizeIssueText, WORK_TYPES,
  type IssueClassificationInput, type WorkType } from "../src/issue-classifier.js";

const input = (overrides: Partial<IssueClassificationInput> = {}): IssueClassificationInput => ({
  issueId: "issue-1", title: "Build an inventory dashboard", summary: "Create a reusable scheduled dashboard",
  inputRevision: issueInputRevision("Build an inventory dashboard", "Create a reusable scheduled dashboard"),
  explicitlyAssigned: false, mandatorySkillNames: [], mandatoryPolicyRule: null, humanAuthorityRule: null, ...overrides,
});
const client = (label: WorkType = "report_or_dashboard_build", confidence = 0.9) => ({
  classify: vi.fn(async () => ({ model: "jev-1.13.0", label, confidence,
    probabilities: Object.fromEntries(WORK_TYPES.map((item) => [item, item === label ? 0.9 : 0.02])),
    requiresHumanDecision: 0.1, usage: { input_tokens: 100, output_tokens: 4 } })),
});

describe("issue classification shadow", () => {
  beforeEach(clearIssueClassificationCache);
  it.each(WORK_TYPES)("accepts the %s label", async (label) => {
    expect(await classifyIssue(input({ issueId: label, inputRevision: label }), client(label))).toMatchObject({ label, fallbackReason: null });
  });
  it("sanitizes and bounds state before inference", () => {
    const value = sanitizeIssueText(`token=abc person@example.com ${"x".repeat(600)}`, 200);
    expect(value).not.toContain("abc"); expect(value).not.toContain("person@example.com"); expect(value).toHaveLength(200);
  });
  it.each([
    [{ explicitlyAssigned: true }, "explicit_assignment_precedence"],
    [{ mandatorySkillNames: ["paperclip"] as string[] }, "mandatory_skill_precedence:paperclip"],
    [{ mandatoryPolicyRule: "mandatory" }, "mandatory_policy_precedence:mandatory"],
    [{ humanAuthorityRule: "board" }, "human_authority_precedence:board"],
  ] as const)("applies deterministic precedence before inference", async (overrides, reason) => {
    const c = client(); const result = await classifyIssue(input(overrides), c);
    expect(result).toMatchObject({ label: null, fallbackReason: reason }); expect(c.classify).not.toHaveBeenCalled();
  });
  it("fails open on malformed output", async () => {
    const c = { classify: vi.fn(async () => ({ model: "jev-1.13.0", label: "invented", confidence: 0.9,
      probabilities: { invented: 1 }, requiresHumanDecision: 0.1, usage: { input_tokens: 1, output_tokens: 1 } })) };
    expect(await classifyIssue(input(), c)).toMatchObject({ label: null, fallbackReason: "InvalidResponseError" });
  });
  it.each([
    ["confidence below zero", { confidence: -0.01 }],
    ["confidence above one", { confidence: 1.01 }],
    ["human-decision probability below zero", { requiresHumanDecision: -0.01 }],
    ["human-decision probability above one", { requiresHumanDecision: 1.01 }],
    ["negative input usage", { usage: { input_tokens: -1, output_tokens: 1 } }],
    ["negative output usage", { usage: { input_tokens: 1, output_tokens: -1 } }],
    ["empty probabilities", { probabilities: {} }],
    ["incomplete probabilities", { probabilities: { bug_fix: 1 } }],
    ["incorrect probability key", { probabilities: { ...Object.fromEntries(WORK_TYPES.map((label) => [label, 0.1])), invented: 0.1 } }],
    ["selected label missing from probabilities", { label: "bug_fix", probabilities: Object.fromEntries(WORK_TYPES.filter((label) => label !== "bug_fix").map((label) => [label, 0.1])) }],
    ["probability below zero", { probabilities: Object.fromEntries(WORK_TYPES.map((label) => [label, label === "bug_fix" ? -0.01 : 0.1])) }],
    ["probability above one", { probabilities: Object.fromEntries(WORK_TYPES.map((label) => [label, label === "bug_fix" ? 1.01 : 0.1])) }],
  ])("rejects malformed output: %s", async (_name, patch) => {
    const valid = await client().classify();
    const c = { classify: vi.fn(async () => ({ ...valid, ...patch })) };
    expect(await classifyIssue(input(), c)).toMatchObject({ label: null, fallbackReason: "InvalidResponseError" });
  });
  it("fails open below the confidence threshold", async () => {
    expect(await classifyIssue(input(), client("bug_fix", 0.59))).toMatchObject({ label: null, fallbackReason: "low_confidence" });
  });
  it("fails open when sanitized candidates are missing", async () => {
    const c = client();
    expect(await classifyIssue(input({ title: "", summary: "" }), c)).toMatchObject({ label: null, fallbackReason: "missing_candidates" });
    expect(c.classify).not.toHaveBeenCalled();
  });
  it("rejects a stale input revision", () => {
    const revision = issueInputRevision("Before", "Summary");
    expect(isCurrentIssueRevision(revision, "Before", "Summary")).toBe(true);
    expect(isCurrentIssueRevision(revision, "After", "Summary")).toBe(false);
    const guarded = issueInputRevision("Before", "Summary", { explicitlyAssigned: false, mandatorySkillNames: [] });
    expect(isCurrentIssueRevision(guarded, "Before", "Summary", { explicitlyAssigned: true, mandatorySkillNames: [] })).toBe(false);
  });
  it.each(["TimeoutError", "RateLimitError", "ConnectionError"])("fails open on %s", async (name) => {
    const c = { classify: vi.fn().mockRejectedValue(Object.assign(new Error(name), { name })) };
    expect(await classifyIssue(input(), c)).toMatchObject({ label: null, fallbackReason: name });
  });
  it("coalesces duplicates and reports incremental usage", async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const c = client();
    c.classify.mockImplementationOnce(async () => { await gate; return { model: "jev-1.13.0", label: "bug_fix", confidence: 0.9,
      probabilities: Object.fromEntries(WORK_TYPES.map((item) => [item, item === "bug_fix" ? 0.9 : 0.02])),
      requiresHumanDecision: 0.1, usage: { input_tokens: 100, output_tokens: 4 } }; });
    const first = classifyIssue(input(), c); const second = classifyIssue(input(), c); release();
    expect(await second).toMatchObject({ cache: "coalesced", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } });
    expect((await first).usage.inputTokens).toBe(100); expect(c.classify).toHaveBeenCalledTimes(1);
  });
  it("invalidates cache on input revision and reports zero-cost hits", async () => {
    const c = client(); await classifyIssue(input(), c);
    expect(await classifyIssue(input(), c)).toMatchObject({ cache: "hit", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } });
    await classifyIssue(input({ inputRevision: "new-revision" }), c); expect(c.classify).toHaveBeenCalledTimes(2);
  });
});

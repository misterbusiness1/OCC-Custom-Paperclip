import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { WORK_TYPES, type ClassificationClient } from "../src/issue-classifier.js";
import { createSkillSuggestionPlugin } from "../src/worker.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const config = {
  issueClassificationShadowEnabled: true,
  issueClassificationKillSwitch: false,
  apiKeyRef: { type: "secret_ref", secretId: "typesafe-test" },
};

function validResponse() {
  return {
    model: "jev-1.13.0",
    label: "feature_build",
    confidence: 0.9,
    probabilities: Object.fromEntries(WORK_TYPES.map((label) => [label, label === "feature_build" ? 0.9 : 0.02])),
    requiresHumanDecision: 0.1,
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

async function setup(classify: ClassificationClient["classify"]) {
  const harness = createTestHarness({
    manifest,
    config,
    capabilities: [...manifest.capabilities, "issues.create", "issues.update"],
  });
  const issue = await harness.ctx.issues.create({
    companyId: COMPANY_ID,
    title: "Build a reusable export",
    description: "Add a new export integration",
  });
  const plugin = createSkillSuggestionPlugin({ issueClassificationClientFactory: () => ({ classify }) });
  await plugin.definition.setup(harness.ctx);
  return { harness, issue };
}

describe("issue classification worker guards", () => {
  it("skips the classifier when an event supplies mandatory skills", async () => {
    const classify = vi.fn(async () => validResponse());
    const { harness, issue } = await setup(classify);

    await harness.emit("issue.updated", { mandatorySkillNames: ["paperclip"] }, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
    });

    expect(classify).not.toHaveBeenCalled();
    expect(harness.getState({
      scopeKind: "issue",
      scopeId: issue.id,
      namespace: "issue-classification-shadow",
      stateKey: "recommendation-v1.1.0",
    })).toMatchObject({ fallbackReason: "mandatory_skill_precedence:paperclip" });
  });

  it("does not persist a delayed unassigned response after assignment", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const classify = vi.fn(async () => {
      markStarted();
      await gate;
      return validResponse();
    });
    const { harness, issue } = await setup(classify);

    const observation = harness.emit("issue.updated", {}, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
    });
    await started;
    await harness.ctx.issues.update(issue.id, { assigneeAgentId: "agent-1" }, COMPANY_ID);
    await harness.emit("issue.updated", {}, {
      companyId: COMPANY_ID,
      entityId: issue.id,
      entityType: "issue",
    });
    release();
    await observation;

    expect(classify).toHaveBeenCalledTimes(1);
    expect(harness.getState({
      scopeKind: "issue",
      scopeId: issue.id,
      namespace: "issue-classification-shadow",
      stateKey: "recommendation-v1.1.0",
    })).toMatchObject({ fallbackReason: "explicit_assignment_precedence" });
  });
});

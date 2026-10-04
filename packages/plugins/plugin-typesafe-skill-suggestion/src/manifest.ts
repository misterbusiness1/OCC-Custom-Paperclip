import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
const manifest: PaperclipPluginManifestV1 = {
  id: "oxford.typesafe-skill-suggestion", apiVersion: 1, version: "0.2.0",
  displayName: "TypeSafe Skill Suggestion", author: "Oxford Cigar Company", categories: ["automation"],
  description: "Default-disabled advisory skill suggestion with preserved shadow telemetry.",
  capabilities: ["secrets.read-ref", "events.subscribe", "issues.read", "plugin.state.read", "plugin.state.write"], entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: { type: "object", properties: {
    apiKeyRef: { type: "string", format: "secret-ref", title: "TypeSafe API key" },
    enabled: { type: "boolean", title: "Enable shadow observation", default: false },
    activeEnabled: { type: "boolean", title: "Enable active advisory injection", default: false },
    model: { type: "string", title: "TypeSafe model", default: "jev-1.13.0" },
    timeoutMs: { type: "number", minimum: 1000, maximum: 15000, default: 5000 },
    maxRetries: { type: "number", minimum: 0, maximum: 2, default: 1 },
    minNeededProbability: { type: "number", minimum: 0, maximum: 1, default: 0.6 },
    minAcceptableProbability: { type: "number", minimum: 0, maximum: 1, default: 0.65 },
    minConfidence: { type: "number", minimum: 0, maximum: 1, default: 0.55 },
    cacheTtlMs: { type: "number", minimum: 1000, maximum: 900000, default: 300000 },
    cacheMaxEntries: { type: "number", minimum: 1, maximum: 512, default: 128 },
    issueClassificationShadowEnabled: { type: "boolean", title: "Enable issue-classification shadow", default: false },
    issueClassificationKillSwitch: { type: "boolean", title: "Disable issue-classification shadow immediately", default: true },
  }, additionalProperties: false },
};
export default manifest;

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
const manifest: PaperclipPluginManifestV1 = {
  id: "oxford.typesafe-skill-suggestion", apiVersion: 1, version: "0.1.0",
  displayName: "TypeSafe Skill Suggestion Shadow", author: "Oxford Cigar Company", categories: ["automation"],
  description: "Default-disabled, observation-only skill suggestion telemetry.",
  capabilities: ["secrets.read-ref", "events.subscribe", "issues.read", "plugin.state.read", "plugin.state.write"], entrypoints: { worker: "./dist/worker.js" },
  instanceConfigSchema: { type: "object", properties: {
    apiKeyRef: { type: "string", format: "secret-ref", title: "TypeSafe API key" },
    enabled: { type: "boolean", title: "Enable shadow observation", default: false },
    timeoutMs: { type: "number", minimum: 1000, maximum: 15000, default: 5000 },
    maxRetries: { type: "number", minimum: 0, maximum: 2, default: 1 },
    issueClassificationShadowEnabled: { type: "boolean", title: "Enable issue-classification shadow", default: false },
    issueClassificationKillSwitch: { type: "boolean", title: "Disable issue-classification shadow immediately", default: true },
  }, additionalProperties: false },
};
export default manifest;

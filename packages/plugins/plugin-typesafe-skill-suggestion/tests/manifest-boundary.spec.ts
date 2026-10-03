import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

describe("issue classification non-mutation boundary", () => {
  it("is default-disabled behind an explicit kill switch", () => {
    const properties = manifest.instanceConfigSchema?.properties as Record<string, { default?: unknown }>;
    expect(properties.issueClassificationShadowEnabled?.default).toBe(false);
    expect(properties.issueClassificationKillSwitch?.default).toBe(true);
  });
  it("has audit-only capabilities and no workflow mutation authority", () => {
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["events.subscribe", "issues.read", "plugin.state.write"]));
    expect(manifest.capabilities).not.toEqual(expect.arrayContaining([
      "issues.update", "issues.checkout", "issues.wakeup", "agents.write", "approvals.write", "config.write",
    ]));
  });
});

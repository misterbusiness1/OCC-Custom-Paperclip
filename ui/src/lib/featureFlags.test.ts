import { describe, expect, it } from "vitest";
import { coerceFlag, resolveFeatureFlag, FeatureFlags } from "./featureFlags";

describe("coerceFlag", () => {
  it("parses truthy toggles", () => {
    for (const v of ["1", "true", "on", "YES", " Enabled "]) {
      expect(coerceFlag(v)).toBe(true);
    }
  });

  it("parses falsy toggles", () => {
    for (const v of ["0", "false", "off", "no", "disabled", ""]) {
      expect(coerceFlag(v)).toBe(false);
    }
  });

  it("returns null for unset or unrecognised values", () => {
    expect(coerceFlag(null)).toBeNull();
    expect(coerceFlag(undefined)).toBeNull();
    expect(coerceFlag("maybe")).toBeNull();
  });
});

describe("resolveFeatureFlag", () => {
  it("defaults to off when no source is set", () => {
    expect(resolveFeatureFlag({})).toBe(false);
    expect(resolveFeatureFlag({ override: null, env: null })).toBe(false);
  });

  it("enables from the env var when no override is present", () => {
    expect(resolveFeatureFlag({ env: "true" })).toBe(true);
    expect(resolveFeatureFlag({ env: "1" })).toBe(true);
  });

  it("lets a localStorage override win over the env default", () => {
    // env off, override on -> on
    expect(resolveFeatureFlag({ override: "on", env: "false" })).toBe(true);
    // env on, override off -> off (QA can force-disable)
    expect(resolveFeatureFlag({ override: "off", env: "true" })).toBe(false);
  });

  it("exposes the canonical flag name", () => {
    expect(FeatureFlags.approvalsDecisionCard).toBe("paperclip.approvals.decisionCard");
  });
});

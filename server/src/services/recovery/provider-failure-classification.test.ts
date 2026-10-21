import { classifyRunLiveness } from "../run-liveness.js";
import { isAiAuthenticationBlocked } from "../ai-auth-failure.js";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("parses the exact Codex usage-limit reset date (OXFA-31266)", () => {
    // Verbatim from the FRA run stdout that triggered the OXFA-31266 storm.
    const now = new Date("2026-09-10T19:05:25.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "You've hit your usage limit … try again at Sep 15th, 2026 1:24 AM",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-15T01:24:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each(["acpx_auth_required", "claude_auth_required", "codex_auth_required", "adapter_auth_missing", "refresh_token_reused", "authentication_required"])("does not automatically retry provider authentication failure %s", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: true });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(true);
    expect(classifyContinuationFailure(run as never)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });

  it.each(["kimi_auth_required", "acpx_auth_required", "gemini_auth_required"])("preserves recovery when %s did not produce an inline repair card", (errorCode) => {
    const classification = classifyRunLiveness({ runStatus: "failed", issue: null, errorCode, authenticationRepairRequested: false });
    const run = { errorCode, ...classification };
    expect(isAiAuthenticationBlocked(run)).toBe(false);
    expect(classifyContinuationFailure(run as never).kind).toBe("default");
  });

  it("uses a typed ACP quota reset without needing the provider's original message", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: "2026-07-15T21:30:00.000Z",
        providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the existing backoff for a typed ACP quota failure with no reset timestamp", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: { errorFamily: "provider_quota" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("routes unavailable engines to a configuration blocker instead of retrying", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_engine_unavailable",
      error: "Node v22.22.2 does not satisfy Codex ACP's Node >=24.11.0 prerequisite.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure({ errorCode: "adapter_engine_unavailable" } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_engine_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});

describe("classifyContinuationFailure", () => {
  it("defers provider_quota to the parsed reset time instead of the flat transient cap (OXFA-31266)", () => {
    const now = new Date("2026-09-10T19:05:25.000Z");
    const classification = classifyContinuationFailure({
      id: "run-1",
      agentId: "agent-1",
      status: "failed",
      error: "You've hit your usage limit … try again at Sep 15th, 2026 1:24 AM",
      errorCode: "provider_quota",
      contextSnapshot: {},
      livenessState: null,
      startedAt: new Date("2026-09-10T19:00:00.000Z"),
      createdAt: new Date("2026-09-10T19:00:00.000Z"),
      resultJson: null,
    }, now);

    expect(classification.kind).toBe("provider_quota");
    expect(classification.maxAttempts).toBe(PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS);
    expect(classification.maxAttempts).not.toBe(3);
    expect(classification.retryAt).toEqual(new Date("2026-09-15T01:24:00.000Z"));
    expect(classification.parsedResetTime).toBe(true);
  });

  it("still treats adapter_failed/timeout as a 3x transient cap (unchanged behaviour)", () => {
    const timeout = classifyContinuationFailure({
      id: "run-2",
      agentId: "agent-1",
      status: "failed",
      error: "request timed out",
      errorCode: "timeout",
      contextSnapshot: {},
      livenessState: null,
      startedAt: new Date("2026-09-10T19:00:00.000Z"),
      createdAt: new Date("2026-09-10T19:00:00.000Z"),
      resultJson: null,
    });
    expect(timeout).toMatchObject({ kind: "transient_infra", maxAttempts: 3, errorCode: "timeout" });

    const adapterFailed = classifyContinuationFailure({
      id: "run-3",
      agentId: "agent-1",
      status: "failed",
      error: "ssh: connection reset",
      errorCode: "adapter_failed",
      contextSnapshot: {},
      livenessState: null,
      startedAt: new Date("2026-09-10T19:00:00.000Z"),
      createdAt: new Date("2026-09-10T19:00:00.000Z"),
      resultJson: null,
    });
    expect(adapterFailed).toMatchObject({ kind: "transient_infra", maxAttempts: 3, errorCode: "adapter_failed" });
  });
});

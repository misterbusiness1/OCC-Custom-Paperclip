import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
  classifyProviderQuotaErrorMessage,
  normalizeProviderQuotaAdapterResult,
} from "./service.js";

// Verbatim run.error values from production heartbeat_runs (Sep 2026).
const DEEPSEEK_INSUFFICIENT_BALANCE = "Insufficient Balance (request_id: dc4ac155-3f57-4b2b-98a3-63346b8c7d95)";
const CLAUDE_ACP_SPEND_LIMIT =
  "Internal error: You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
const CLAUDE_ACP_SESSION_LIMIT_10PM = "Internal error: You've hit your session limit · resets 10pm (UTC)";
const CLAUDE_ACP_SESSION_LIMIT_3_10AM = "Internal error: You've hit your session limit · resets 3:10am (UTC)";
const CLAUDE_ACP_SESSION_LIMIT_5AM = "Internal error: You've hit your session limit · resets 5am (UTC)";
const CLAUDE_ACP_RATE_LIMIT =
  "Internal error: API Error: This request would exceed your account's rate limit. Please try again later.";
const KIMI_FIVE_HOUR_LIMIT = "403 You've reached your 5-hour usage limit";

// opencode_local stdout shape for the DeepSeek 402 (trimmed).
const OPENCODE_402_STDOUT = JSON.stringify({
  type: "error",
  sessionID: "ses_f2a400669ffeDVQH43IcasOPVI",
  error: {
    name: "APIError",
    data: {
      message: DEEPSEEK_INSUFFICIENT_BALANCE,
      statusCode: 402,
      isRetryable: false,
      responseHeaders: { "content-type": "application/json", server: "elb" },
    },
  },
});

type FailedResultFixture = {
  exitCode: number | null;
  signal: null;
  timedOut: boolean;
  errorMessage: string | null;
  errorCode?: string | null;
  errorFamily?: "provider_quota" | "transient_upstream" | null;
  retryNotBefore?: string | null;
  resultJson?: Record<string, unknown> | null;
};

function failedResult(
  overrides: Partial<FailedResultFixture> & Pick<FailedResultFixture, "errorMessage">,
): FailedResultFixture {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "adapter_failed",
    resultJson: { stdout: "", stderr: "" },
    ...overrides,
  };
}

describe("classifyProviderQuotaErrorMessage", () => {
  it.each([
    ["Insufficient Balance", "balance_exhausted"],
    [DEEPSEEK_INSUFFICIENT_BALANCE, "balance_exhausted"],
    [CLAUDE_ACP_SPEND_LIMIT, "balance_exhausted"],
    ["Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.", "balance_exhausted"],
    ["429 You exceeded your current quota, please check your plan and billing details. (code: insufficient_quota)", "balance_exhausted"],
    ["insufficient_quota", "balance_exhausted"],
    ["402 Payment Required", "balance_exhausted"],
    ["HTTP 402: {\"error\":{\"message\":\"Insufficient credits\"}}", "balance_exhausted"],
    ["This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1200.", "balance_exhausted"],
    [CLAUDE_ACP_SESSION_LIMIT_10PM, "usage_limit"],
    [CLAUDE_ACP_SESSION_LIMIT_3_10AM, "usage_limit"],
    [KIMI_FIVE_HOUR_LIMIT, "usage_limit"],
    [CLAUDE_ACP_RATE_LIMIT, "usage_limit"],
    ["You've hit your weekly limit · resets Oct 2, 5pm (UTC)", "usage_limit"],
    ["Claude AI usage limit reached|1790370000", "usage_limit"],
    ["rate_limit_error: Number of request tokens has exceeded your per-minute rate limit", "usage_limit"],
    ["RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute'", "usage_limit"],
  ])("classifies %j as %s", (message, kind) => {
    expect(classifyProviderQuotaErrorMessage(message)).toBe(kind);
  });

  it.each([
    // Genuine auth failures stay auth failures, even when a limit is mentioned.
    "401 Unauthorized: invalid x-api-key",
    "Invalid API key · Please run /login",
    "Not logged in · Please run /login",
    "authentication_error: invalid bearer token (rate limit headers omitted)",
    "Error: 401 {\"error\":{\"message\":\"Incorrect API key provided\",\"code\":\"insufficient_quota\"}}",
    // A transient 429 throttle stays on the transient retry path.
    "Upstream provider responded 429: you have been rate limited, please retry later.",
    // Unrelated failures.
    "Kimi exited with code 1.",
    "Workspace storage capacity limit reached.",
    "spawn opencode ENOENT",
    "TypeError: cannot read properties of undefined (reading 'limit')",
    "Error at line 402 of generated.ts",
    "",
    null,
  ])("does not classify %j", (message) => {
    expect(classifyProviderQuotaErrorMessage(message)).toBeNull();
  });
});

describe("normalizeProviderQuotaAdapterResult", () => {
  it("reclassifies the opencode DeepSeek 402 balance failure and defers by the default backoff", () => {
    const now = new Date("2026-09-24T23:28:45.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorMessage: DEEPSEEK_INSUFFICIENT_BALANCE,
      resultJson: { stdout: OPENCODE_402_STDOUT, stderr: "" },
    }), now);

    expect(normalized).toMatchObject({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS).toISOString(),
      resultJson: {
        stdout: OPENCODE_402_STDOUT,
        errorFamily: "provider_quota",
        providerQuotaKind: "balance_exhausted",
        providerQuotaResetSource: "default",
        originalErrorCode: "adapter_failed",
      },
    });
  });

  it("treats a missing errorCode (server default adapter_failed) as generic", () => {
    const now = new Date("2026-09-24T23:28:45.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorCode: null,
      errorMessage: "Insufficient Balance",
    }), now);
    expect(normalized.errorCode).toBe("provider_quota");
    expect(normalized.resultJson).toMatchObject({ originalErrorCode: null, providerQuotaKind: "balance_exhausted" });
  });

  it.each([
    [CLAUDE_ACP_SESSION_LIMIT_3_10AM, "2026-09-24T22:00:00.000Z", "2026-09-25T03:10:00.000Z"],
    [CLAUDE_ACP_SESSION_LIMIT_10PM, "2026-09-24T23:00:00.000Z", "2026-09-25T22:00:00.000Z"],
    [CLAUDE_ACP_SESSION_LIMIT_10PM, "2026-09-24T21:00:00.000Z", "2026-09-24T22:00:00.000Z"],
    [CLAUDE_ACP_SESSION_LIMIT_5AM, "2026-09-24T22:00:00.000Z", "2026-09-25T05:00:00.000Z"],
    ["You've hit your session limit · resets 3pm", "2026-09-24T10:00:00.000Z", "2026-09-24T15:00:00.000Z"],
    ["You've hit your weekly limit · resets Oct 2, 5pm (UTC)", "2026-09-24T10:00:00.000Z", "2026-10-02T17:00:00.000Z"],
    ["You've hit your usage limit. Try again after 2026-09-25T15:00:00Z", "2026-09-24T10:00:00.000Z", "2026-09-25T15:00:00.000Z"],
    ["Rate limit exceeded, please try again in 20 minutes", "2026-09-24T10:00:00.000Z", "2026-09-24T10:20:00.000Z"],
    ["Claude AI usage limit reached|1790370000", "2026-09-24T10:00:00.000Z", "2026-09-25T21:00:00.000Z"],
  ])("parses the provider reset from %j", (errorMessage, nowIso, expectedIso) => {
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorCode: "acpx_turn_failed",
      errorMessage,
    }), new Date(nowIso));

    expect(normalized.errorCode).toBe("provider_quota");
    expect(normalized.errorFamily).toBe("provider_quota");
    expect(normalized.retryNotBefore).toBe(expectedIso);
    expect(normalized.resultJson).toMatchObject({
      providerQuotaResetSource: "provider",
      originalErrorCode: "acpx_turn_failed",
    });
  });

  it("reads a Retry-After response header from the adapter output", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const stdout = JSON.stringify({
      type: "error",
      error: { data: { message: "Rate limit reached", statusCode: 429, responseHeaders: { "retry-after": "120" } } },
    });
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorMessage: "Rate limit reached for requests",
      resultJson: { stdout: JSON.stringify({ wrapped: stdout }) },
    }), now);
    expect(normalized.retryNotBefore).toBe("2026-09-24T10:02:00.000Z");
  });

  it("falls back to the default backoff for a usage limit without a reset time", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorCode: "kimi_execution_failed",
      errorMessage: KIMI_FIVE_HOUR_LIMIT,
    }), now);
    expect(normalized).toMatchObject({
      errorCode: "provider_quota",
      retryNotBefore: "2026-09-24T11:00:00.000Z",
      resultJson: { providerQuotaKind: "usage_limit", providerQuotaResetSource: "default" },
    });
  });

  it("never retries a balance failure sooner than the default backoff", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorMessage: "Insufficient Balance, retry after 5 seconds",
    }), now);
    expect(normalized).toMatchObject({
      retryNotBefore: "2026-09-24T11:00:00.000Z",
      resultJson: { providerQuotaKind: "balance_exhausted", providerQuotaResetSource: "default" },
    });
  });

  it("discards an implausibly distant reset matched from agent output", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorMessage: "You've hit your usage limit",
      resultJson: { stdout: "curl -H 'Retry-After: 9999999' https://example.test" },
    }), now);
    expect(normalized).toMatchObject({
      retryNotBefore: "2026-09-24T11:00:00.000Z",
      resultJson: { providerQuotaResetSource: "default" },
    });
  });

  it("does not read a reset clock out of a longer word such as 'presets'", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorMessage: "You've hit your usage limit (loaded presets 10:30)",
    }), now);
    expect(normalized.retryNotBefore).toBe("2026-09-24T11:00:00.000Z");
  });

  it("ignores a stale reset timestamp instead of retrying immediately", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorMessage: "You've hit your usage limit. Try again after 2026-09-20T15:00:00Z",
    }), now);
    expect(normalized.retryNotBefore).toBe("2026-09-24T11:00:00.000Z");
  });

  it.each([
    ["an auth failure", failedResult({ errorCode: "acpx_turn_failed", errorMessage: "401 Unauthorized: invalid x-api-key" })],
    ["an adapter-specific code", failedResult({ errorCode: "claude_auth_required", errorMessage: "Insufficient Balance" })],
    ["an already-classified family", failedResult({ errorCode: "claude_transient_upstream", errorFamily: "transient_upstream", errorMessage: CLAUDE_ACP_RATE_LIMIT })],
    ["a timeout", failedResult({ errorCode: "timeout", timedOut: true, errorMessage: "Insufficient Balance" })],
    ["a successful run", failedResult({ exitCode: 0, errorCode: null, errorMessage: null })],
    ["an unrelated failure", failedResult({ errorMessage: "Kimi exited with code 1." })],
  ])("leaves %s untouched", (_label, result) => {
    expect(normalizeProviderQuotaAdapterResult(result)).toBe(result);
  });
});

describe("recovery classification of generic adapter quota failures", () => {
  const baseRun = {
    id: "run-1",
    agentId: "agent-1",
    status: "failed",
    contextSnapshot: {},
    livenessState: null,
    startedAt: new Date("2026-09-24T19:00:00.000Z"),
    createdAt: new Date("2026-09-24T19:00:00.000Z"),
    resultJson: null,
  };

  it("classifies historical adapter_failed balance runs as provider_quota with the default backoff", () => {
    const now = new Date("2026-09-24T23:30:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: DEEPSEEK_INSUFFICIENT_BALANCE,
      resultJson: { stdout: OPENCODE_402_STDOUT },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("classifies historical acpx_turn_failed session-limit runs and parses the reset", () => {
    const now = new Date("2026-09-24T22:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: CLAUDE_ACP_SESSION_LIMIT_3_10AM,
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-25T03:10:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("honours an adapter-reported provider_quota family on a generic plugin code", () => {
    const now = new Date("2026-09-24T10:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "kimi_execution_failed",
      error: "Kimi exited with code 1.",
      resultJson: { errorFamily: "provider_quota", retryNotBefore: "2026-09-24T15:00:00.000Z" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-09-24T15:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("does not reclassify acpx_turn_failed auth or config-like failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Internal error: Invalid API key · Please run /login",
      resultJson: null,
    })).toBeNull();
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "Internal error: model claude-x not found",
      resultJson: null,
    })).toBeNull();
  });

  it("reports a persisted default deferral as not provider-parsed", () => {
    const now = new Date("2026-09-24T23:28:45.000Z");
    const normalized = normalizeProviderQuotaAdapterResult(failedResult({
      errorMessage: DEEPSEEK_INSUFFICIENT_BALANCE,
    }), now);
    const later = new Date(now.getTime() + 5 * 60 * 1000);
    expect(classifyAdapterFailureForRecovery({
      errorCode: normalized.errorCode ?? null,
      error: DEEPSEEK_INSUFFICIENT_BALANCE,
      resultJson: normalized.resultJson ?? null,
    }, later)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("defers balance exhaustion instead of the 3x/60s transient retry", () => {
    const now = new Date("2026-09-24T23:30:00.000Z");
    const classification = classifyContinuationFailure({
      ...baseRun,
      errorCode: "adapter_failed",
      error: "Insufficient Balance",
    }, now);
    expect(classification).toMatchObject({
      kind: "provider_quota",
      maxAttempts: PROVIDER_QUOTA_RECOVERY_MAX_ATTEMPTS,
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("defers acpx_turn_failed spend-limit and session-limit runs", () => {
    const now = new Date("2026-09-24T22:00:00.000Z");
    expect(classifyContinuationFailure({
      ...baseRun,
      errorCode: "acpx_turn_failed",
      error: CLAUDE_ACP_SPEND_LIMIT,
    }, now)).toMatchObject({ kind: "provider_quota", parsedResetTime: false });
    expect(classifyContinuationFailure({
      ...baseRun,
      errorCode: "acpx_turn_failed",
      error: CLAUDE_ACP_SESSION_LIMIT_10PM,
    }, now)).toMatchObject({
      kind: "provider_quota",
      // "resets 10pm" seen at exactly 22:00 is tomorrow's reset, never now.
      retryAt: new Date("2026-09-25T22:00:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("keeps non-quota acpx_turn_failed runs on the default path", () => {
    expect(classifyContinuationFailure({
      ...baseRun,
      errorCode: "acpx_turn_failed",
      error: "Internal error: Prompt failed",
    })).toMatchObject({ kind: "default" });
  });
});

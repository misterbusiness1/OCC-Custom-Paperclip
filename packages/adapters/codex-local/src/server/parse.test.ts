import { describe, expect, it } from "vitest";
import {
  classifyCodexAuthRefreshFailure,
  extractCodexAcpQuotaRetryNotBefore,
  extractCodexRetryNotBefore,
  isCodexHarnessCrash,
  isCodexAcpProviderQuotaSummary,
  isCodexAcpTerminalDiagnosticSummary,
  isCodexAcpTransientUpstreamSummary,
  unwrapCodexAcpTerminalDiagnostic,
  isCodexProviderQuotaError,
  isCodexTransientUpstreamError,
  isCodexUnknownSessionError,
  parseCodexJsonl,
} from "./parse.js";

describe("Codex ACP credits quota summary", () => {
  const prefix = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ";

  it.each([
    "Sep 8th, 2026 2:00 PM.",
    "an unavailable reset time.",
  ])("recognizes the credits quota sentence without inventing a reset for %s", (reset) => {
    const summary = prefix + reset;
    expect(isCodexAcpProviderQuotaSummary(summary)).toBe(true);
    // This dated provider format has no proven timezone contract. Preserve the
    // scheduler's bounded fallback instead of guessing an absolute reset.
    expect(extractCodexRetryNotBefore({ errorMessage: summary }, new Date("2026-09-08T01:00:00Z"))).toBeNull();
  });

  it.each([
    `Provider said: "${prefix}Sep 8th, 2026 2:00 PM."`,
    `"${prefix}Sep 8th, 2026 2:00 PM."`,
    prefix.replace("chatgpt.com", "chatgpt.com.example.invalid") + "Sep 8th, 2026 2:00 PM.",
    prefix.replace("https://", "http://") + "Sep 8th, 2026 2:00 PM.",
    prefix.replace("/usage", "/usage?token=synthetic") + "Sep 8th, 2026 2:00 PM.",
    prefix + "Sep 8th, 2026 2:00 PM.\nUnrelated failure.",
    prefix + "Sep 8th,\n2026 2:00 PM.",
    prefix + "x".repeat(161),
    prefix,
    "You've hit your usage limit. To get more access now, send a request to your admin or try again at Sep 8th, 2026 2:00 PM.",
  ])("rejects a nonmatching credits quota summary: %s", (summary) => {
    expect(isCodexAcpProviderQuotaSummary(summary)).toBe(false);
  });
});

describe("Codex ACP terminal diagnostics (2026-10-19 production shapes)", () => {
  const credits = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 24th, 2026 8:40 PM.";
  const skillsWarning = "Warning: Exceeded skills context budget of 2%. All skill descriptions were removed and 108 additional skills were not included in the model-visible skills list.";
  const now = new Date(2026, 9, 20, 2, 15);

  it.each([
    ["exact", credits],
    ["skills warning first", `${skillsWarning}\n\n${credits}`],
    ["remote compaction wrapper", `Error running remote compact task: ${credits}`],
    ["upstream settings URL", credits.replace("/codex/settings/", "/settings/")],
    ["curly apostrophe", credits.replace("You've", "You’ve")],
  ])("recognizes the credits quota %s and reads its local reset", (_label, summary) => {
    expect(isCodexAcpProviderQuotaSummary(summary)).toBe(true);
    expect(isCodexAcpTransientUpstreamSummary(summary)).toBe(false);
    expect(unwrapCodexAcpTerminalDiagnostic(summary)).toBe(summary.slice(summary.indexOf("You")));
    // Codex prints the reset in its process-local zone (format_retry_timestamp),
    // in whole minutes, so the retry waits until the printed minute has ended.
    expect(extractCodexAcpQuotaRetryNotBefore(summary, now)?.getTime()).toBe(new Date(2026, 9, 24, 20, 41).getTime());
  });

  it("reads a same-day clock reset", () => {
    const summary = credits.replace("Oct 24th, 2026 8:40 PM", "8:40 PM");
    expect(extractCodexAcpQuotaRetryNotBefore(summary, now)?.getTime()).toBe(new Date(2026, 9, 20, 20, 41).getTime());
  });

  it.each([
    ["inside the printed minute", new Date(2026, 9, 24, 20, 40, 20), new Date(2026, 9, 24, 20, 41)],
    ["just after the printed minute", new Date(2026, 9, 24, 20, 41, 30), new Date(2026, 9, 24, 20, 42, 30)],
  ])("never rolls a same-day reset to tomorrow when the retry lands %s", (_label, at, expected) => {
    const summary = credits.replace("Oct 24th, 2026 8:40 PM", "8:40 PM");
    expect(extractCodexAcpQuotaRetryNotBefore(summary, at)?.getTime()).toBe(expected.getTime());
  });

  it("reads a same-day reset printed just before midnight as the day that ended", () => {
    const summary = credits.replace("Oct 24th, 2026 8:40 PM", "11:59 PM");
    const at = new Date(2026, 9, 25, 0, 0, 5);
    expect(extractCodexAcpQuotaRetryNotBefore(summary, at)?.getTime()).toBe(at.getTime() + 60_000);
  });

  it.each([
    ["just after 1 AM", new Date(2026, 9, 24, 1, 0), "11:00 PM", new Date(2026, 9, 24, 23, 1)],
    ["in the afternoon", new Date(2026, 9, 24, 13, 0), "11:59 PM", new Date(2026, 9, 25, 0, 0)],
  ])("keeps a same-day reset later the same day (%s)", (_label, at, reset, expected) => {
    const summary = credits.replace("Oct 24th, 2026 8:40 PM", reset);
    expect(extractCodexAcpQuotaRetryNotBefore(summary, at)?.getTime()).toBe(expected.getTime());
  });

  it("waits a minute, not zero, for a dated reset that has already passed", () => {
    const summary = credits.replace("Oct 24th, 2026 8:40 PM", "Oct 19th, 2026 8:40 PM");
    expect(extractCodexAcpQuotaRetryNotBefore(summary, now)?.getTime()).toBe(now.getTime() + 60_000);
  });

  it.each([
    ["eight days ahead", "Oct 28th, 2026 1:00 AM", new Date(2026, 9, 28, 1, 1)],
    ["beyond the weekly horizon", "Oct 28th, 2026 8:40 PM", null],
    ["far beyond the horizon", "Nov 30th, 2026 8:40 PM", null],
    ["without a time", "a later time", null],
  ])("bounds a reset %s", (_label, reset, expected) => {
    expect(extractCodexAcpQuotaRetryNotBefore(credits.replace("Oct 24th, 2026 8:40 PM", reset), now)?.getTime() ?? null)
      .toBe(expected?.getTime() ?? null);
  });

  it("rejects an impossible date inside the horizon instead of rolling it over", () => {
    const lateFebruary = new Date(2027, 1, 25, 12, 0);
    const summary = (day: string) => credits.replace("Oct 24th, 2026", `Feb ${day}, 2027`);
    expect(extractCodexAcpQuotaRetryNotBefore(summary("28th"), lateFebruary)?.getTime()).toBe(new Date(2027, 1, 28, 20, 41).getTime());
    expect(extractCodexAcpQuotaRetryNotBefore(summary("30th"), lateFebruary)).toBeNull();
  });

  it.each([
    "exceeded retry limit, last status: 429 Too Many Requests",
    "exceeded retry limit, last status: 429 Too Many Requests, request id: req_123",
    "exceeded retry limit, last status: 429 Too Many Requests, request id: a1b2/c3+d4==",
    "exceeded retry limit, last status: 503 Service Unavailable",
    "Selected model is at capacity. Please try a different model.",
    `${skillsWarning}\n\nexceeded retry limit, last status: 429 Too Many Requests`,
  ])("recognizes the transient upstream sentence: %s", (summary) => {
    expect(isCodexAcpTransientUpstreamSummary(summary)).toBe(true);
    expect(isCodexAcpProviderQuotaSummary(summary)).toBe(false);
    expect(isCodexAcpTerminalDiagnosticSummary(summary)).toBe(true);
  });

  it.each([
    "exceeded retry limit, last status: 400 Bad Request",
    "The provider said: exceeded retry limit, last status: 429 Too Many Requests",
    "exceeded retry limit, last status: 429 Too Many Requests\nI will retry later.",
    "The requested model is at capacity. Please try again later.",
    skillsWarning,
    `${skillsWarning}\n\nI could not finish the task.`,
    `${skillsWarning}\n${credits}`,
    `Error running remote compact task: ${skillsWarning}\n\nsomething else`,
    `Provider said: Error running remote compact task: ${credits}`,
  ])("rejects a framed or nonmatching diagnostic: %s", (summary) => {
    expect(isCodexAcpTerminalDiagnosticSummary(summary)).toBe(false);
  });
});

describe("parseCodexJsonl", () => {
  it("captures session id, assistant summary, usage, and error message", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Recovered response" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "resume failed" } }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Recovered response",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      usageBasis: "per_run",
      errorMessage: "resume failed",
      sawProtocolEvent: true,
      sawProtocolTerminalEvent: true,
    });
  });

  it("uses the last agent message as the summary when commentary updates precede the final answer", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "Checking the heartbeat procedure" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I’m checking out the issue and reading the docs now." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Fixed the issue and verified the targeted tests pass." },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n");

    expect(parseCodexJsonl(stdout)).toEqual({
      sessionId: "thread_123",
      summary: "Fixed the issue and verified the targeted tests pass.",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
      },
      usageBasis: "per_run",
      errorMessage: null,
      sawProtocolEvent: true,
      sawProtocolTerminalEvent: true,
    });
  });
});

describe("isCodexHarnessCrash", () => {
  const crashedMidTurnStream = [
    JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Checking out the issue now." },
    }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution" } }),
  ].join("\n");

  it("classifies a nonzero exit with no protocol-terminal event as a harness crash", () => {
    const parsed = parseCodexJsonl(crashedMidTurnStream);
    expect(parsed.sawProtocolEvent).toBe(true);
    expect(parsed.sawProtocolTerminalEvent).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: 1, ...parsed })).toBe(true);
  });

  it("does not classify runs whose turn reached a protocol-terminal event", () => {
    const failedInProtocol = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({ type: "turn.failed", error: { message: "the model rejected the request" } }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...failedInProtocol })).toBe(false);

    const completedThenFailedExit = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
        }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...completedThenFailedExit })).toBe(false);
  });

  it("does not classify successful exits or streams that never spoke the protocol", () => {
    expect(isCodexHarnessCrash({ exitCode: 0, ...parseCodexJsonl(crashedMidTurnStream) })).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: null, ...parseCodexJsonl(crashedMidTurnStream) })).toBe(false);

    const neverStarted = parseCodexJsonl("error: unexpected argument '--bogus-flag'\n");
    expect(neverStarted.sawProtocolEvent).toBe(false);
    expect(isCodexHarnessCrash({ exitCode: 2, ...neverStarted })).toBe(false);
  });

  it("stays structural: agent output discussing network errors does not affect classification", () => {
    const parsed = parseCodexJsonl(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "The deploy failed with connection reset by peer; investigating." },
        }),
        JSON.stringify({ type: "turn.failed", error: { message: "agent gave up" } }),
      ].join("\n"),
    );
    expect(isCodexHarnessCrash({ exitCode: 1, ...parsed })).toBe(false);
    expect(
      isCodexTransientUpstreamError({
        stdout: "connection reset by peer while running the deploy",
        errorMessage: "agent gave up",
      }),
    ).toBe(false);
  });
});

describe("classifyCodexAuthRefreshFailure", () => {
  it("classifies explicit refresh-token failure messages", () => {
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "provider error: refresh_token_reused" })).toBe(
      "refresh_token_reused",
    );
    expect(classifyCodexAuthRefreshFailure({ stderr: "OAuth failed: refresh token has expired" })).toBe(
      "refresh_token_expired",
    );
    expect(classifyCodexAuthRefreshFailure({ stdout: "OAuth failed: invalid_grant" })).toBe(
      "refresh_token_invalidated",
    );
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "credential refresh returned 401 Unauthorized" })).toBe(
      "refresh_token_invalidated",
    );
  });

  it("does not classify bare 401 or quota messages as auth-refresh failures", () => {
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "chatgpt wham api returned 401" })).toBeNull();
    expect(classifyCodexAuthRefreshFailure({ errorMessage: "You've hit your usage limit for GPT-5." })).toBeNull();
  });
});

describe("isCodexUnknownSessionError", () => {
  it("detects the current missing-rollout thread error", () => {
    expect(
      isCodexUnknownSessionError(
        "",
        "Error: thread/resume: thread/resume failed: no rollout found for thread id d448e715-7607-4bcc-91fc-7a3c0c5a9632",
      ),
    ).toBe(true);
  });

  it("still detects existing stale-session wordings", () => {
    expect(isCodexUnknownSessionError("unknown thread id", "")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db missing rollout path for thread abc")).toBe(true);
    expect(isCodexUnknownSessionError("", "state db returned stale rollout path for thread abc")).toBe(true);
  });

  it("does not classify unrelated Codex failures as stale sessions", () => {
    expect(isCodexUnknownSessionError("", "model overloaded")).toBe(false);
  });
});

describe("isCodexTransientUpstreamError", () => {
  it("recognizes only an unquoted ACP provider-quota summary", () => {
    const summary = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.";

    expect(isCodexAcpProviderQuotaSummary(summary)).toBe(true);
    expect(isCodexAcpProviderQuotaSummary(`Provider said: \"${summary}\"`)).toBe(false);
    expect(isCodexAcpProviderQuotaSummary("The requested model is at capacity. Please try again later.")).toBe(false);
    expect(isCodexAcpProviderQuotaSummary("An ordinary adapter failure occurred.")).toBe(false);
  });

  it("parses the supported ACP provider reset clock independently", () => {
    const now = new Date("2026-04-23T03:29:02.000Z");
    expect(extractCodexRetryNotBefore({
      errorMessage: "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM (America/Chicago).",
    }, now)?.toISOString()).toBe("2026-04-23T04:31:00.000Z");
  });

  it("classifies the remote-compaction high-demand failure as transient upstream", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage:
          "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
    expect(
      isCodexTransientUpstreamError({
        stderr: "We're currently experiencing high demand, which may cause temporary errors.",
      }),
    ).toBe(true);
  });

  it("classifies usage-limit windows as provider quota and extracts the retry time", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM.";
    const now = new Date(2026, 3, 22, 22, 29, 2);

    expect(isCodexProviderQuotaError({ errorMessage })).toBe(true);
    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.getTime()).toBe(
      new Date(2026, 3, 22, 23, 31, 0, 0).getTime(),
    );
  });

  it("classifies model-capacity messages as provider quota without reset metadata", () => {
    const errorMessage = "The requested model is at capacity. Please try again later.";

    expect(isCodexProviderQuotaError({ errorMessage })).toBe(true);
    expect(isCodexTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractCodexRetryNotBefore({ errorMessage })).toBeNull();
  });

  it("parses explicit timezone hints on usage-limit retry windows", () => {
    const errorMessage = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 11:31 PM (America/Chicago).";
    const now = new Date("2026-04-23T03:29:02.000Z");

    expect(extractCodexRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-23T04:31:00.000Z",
    );
  });

  it("does not classify deterministic compaction errors as transient", () => {
    expect(
      isCodexTransientUpstreamError({
        errorMessage: [
          "Error running remote compact task: {",
          '  "error": {',
          '    "message": "Unknown parameter: \'prompt_cache_retention\'.",',
          '    "type": "invalid_request_error",',
          '    "param": "prompt_cache_retention",',
          '    "code": "unknown_parameter"',
          "  }",
          "}",
        ].join("\n"),
      }),
    ).toBe(false);
  });
});

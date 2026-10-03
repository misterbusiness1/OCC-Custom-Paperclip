import { describe, expect, it } from "vitest";
import {
  ACP_WRAPPED_QUOTA_RETRY_DELAY_MS,
  classifyAcpTerminalFailure,
} from "./terminal-failure-classification.js";

describe("classifyAcpTerminalFailure", () => {
  const now = Date.parse("2030-04-22T16:00:00.000Z");

  it.each([
    "Authentication required: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
    "Authentication required: 403 You’ve reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
  ])("gives only the explicit Kimi five-hour wrapper a five-hour cooldown", (message) => {
    expect(classifyAcpTerminalFailure(message, now)).toEqual({
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: new Date(now + ACP_WRAPPED_QUOTA_RETRY_DELAY_MS).toISOString(),
    });
  });

  it.each([
    "Authorization failed: quota exceeded",
    "Unauthorized: usage limit unavailable",
    "Authentication required: 403 quota exceeded",
    "Authentication failed: invalid API key; quota status unavailable",
    "invalid_grant: quota refresh failed",
  ])("preserves hard-auth precedence for %s", (message) => {
    expect(classifyAcpTerminalFailure(message, now)).toEqual({
      errorCode: "acpx_auth_required",
      errorFamily: null,
      retryNotBefore: null,
    });
  });

  it.each([
    "You've hit your usage limit. Try again later.",
    "Provider quota exceeded for this model.",
    "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.",
  ])("preserves the generic quota path without inventing a five-hour cooldown for %s", (message) => {
    expect(classifyAcpTerminalFailure(message, now)).toEqual({
      errorCode: "acpx_turn_failed",
      errorFamily: null,
      retryNotBefore: null,
    });
  });

  it.each([
    "429 Too Many Requests: quota exceeded",
    "Provider rate limit exceeded",
  ])("keeps HTTP/rate throttling transient for %s", (message) => {
    expect(classifyAcpTerminalFailure(message, now)).toEqual({
      errorCode: "acpx_transient_upstream",
      errorFamily: "transient_upstream",
      retryNotBefore: null,
    });
  });

  it("leaves an ordinary failed terminal on the generic path", () => {
    expect(classifyAcpTerminalFailure("ordinary ACP failure", now)).toEqual({
      errorCode: "acpx_turn_failed",
      errorFamily: null,
      retryNotBefore: null,
    });
  });
});

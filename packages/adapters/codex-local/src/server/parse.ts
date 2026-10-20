import {
  asString,
  asNumber,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later)/i;
const CODEX_REMOTE_COMPACTION_RE = /remote\s+compact\s+task/i;
const CODEX_USAGE_LIMIT_RE =
  /you(?:'|’)ve hit your usage limit for .+\.\s+switch to another model now,\s+or try again at\s+([^.!\n]+)(?:[.!]|\n|$)/i;
const CODEX_ACP_PROVIDER_QUOTA_SUMMARY_RE =
  /^you(?:'|’)ve hit your usage limit for .+\.\s+switch to another model now,\s+or try again at\s+[^.!\n]+(?:[.!])?$/i;
const CODEX_ACP_CREDITS_QUOTA_SUMMARY_RE =
  /^you(?:'|’)ve hit your usage limit\. Visit https:\/\/chatgpt\.com\/(?:codex\/)?settings\/usage to purchase more credits or try again at ([^.!?\r\n]{1,160})[.!]?$/i;
// Codex's RetryLimitReachedError and ServerOverloaded texts (codex-rs
// protocol/src/error.rs). Both are throttles that clear on their own.
const CODEX_ACP_TRANSIENT_UPSTREAM_SUMMARY_RE =
  /^(?:exceeded retry limit, last status: (?:429 Too Many Requests|5\d\d [A-Za-z ]{1,40})(?:, request id: [^\s,]{1,128})?|Selected model is at capacity\. Please try a different model\.)$/i;
// Codex-owned framing that can surround the provider sentence in the same
// failed turn: a leading skills-budget warning and the remote compaction
// wrapper. Anything else in the output keeps the turn generic.
const CODEX_ACP_SKILLS_BUDGET_WARNING_RE =
  /^Warning: Exceeded skills context budget of \d{1,3}%\.[^\r\n]{0,300}\r?\n\s*\n/i;
const CODEX_ACP_REMOTE_COMPACT_PREFIX_RE = /^Error running remote compact task: /i;
// Codex prints reset times in its process-local zone as "%b %-d{suffix}, %Y
// %-I:%M %p", or "%-I:%M %p" for a same-day reset (format_retry_timestamp).
const CODEX_ACP_DATED_RESET_RE =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2})(?:st|nd|rd|th), (\d{4}) (\d{1,2}):(\d{2}) ([AP])M$/i;
const CODEX_ACP_SAME_DAY_RESET_RE = /^(\d{1,2}):(\d{2}) ([AP])M$/i;
const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
// Codex's longest usage window is weekly; a later reset is not a provider
// window and stays on the server's bounded fallback.
const CODEX_ACP_MAX_RESET_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;
// Codex prints whole minutes, so the real reset can be up to 59 s later.
const CODEX_ACP_RESET_MINUTE_CEILING_MS = 60_000;
const CODEX_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit|model (?:is )?at capacity|at capacity for this model|capacity limit)/i;
const CODEX_REFRESH_TOKEN_REUSED_RE =
  /(?:refresh[_\s-]?token[_\s-]?reused|refresh token (?:has )?already been used|token reuse detected)/i;
const CODEX_REFRESH_TOKEN_EXPIRED_RE =
  /(?:refresh[_\s-]?token[_\s-]?expired|refresh token (?:has )?expired|expired refresh token)/i;
const CODEX_REFRESH_TOKEN_INVALIDATED_RE =
  /(?:refresh[_\s-]?token[_\s-]?(?:invalidated|revoked|invalid)|refresh token (?:has been )?(?:invalidated|revoked|invalid)|invalid refresh token|missing bearer)/i;
const CODEX_OAUTH_INVALID_GRANT_RE = /\binvalid_grant\b/i;
const CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE =
  /(?:(?:oauth|refresh|access[_\s-]?token|bearer|credential).{0,80}(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b)|(?:\b401\b|unauthori[sz]ed|\binvalid[\s-]grant\b).{0,80}(?:oauth|refresh|access[_\s-]?token|bearer|credential))/i;

export type CodexAuthRefreshFailureClass =
  | "refresh_token_reused"
  | "refresh_token_expired"
  | "refresh_token_invalidated";

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  let sawProtocolEvent = false;
  let sawProtocolTerminalEvent = false;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type) sawProtocolEvent = true;
    if (type === "error" || type === "turn.completed" || type === "turn.failed") {
      sawProtocolTerminalEvent = true;
    }
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) finalMessage = text;
      }
      continue;
    }

    if (type === "turn.completed") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: finalMessage?.trim() ?? "",
    usage,
    usageBasis: "per_run" as const,
    errorMessage,
    sawProtocolEvent,
    sawProtocolTerminalEvent,
  };
}

/**
 * Structural crash detection: the codex CLI can only report an agent-level
 * failure through the JSONL protocol (an `error` event, `turn.failed`, or a
 * finished `turn.completed` followed by a nonzero exit). A nonzero exit after
 * the protocol stream started but before any terminal event means the process
 * died out from under the agent (MCP transport crash, worker panic, killed
 * tool server) — retriable infrastructure, not agent behavior. This
 * deliberately does not match error text: transport failure strings vary, and
 * stdout/stderr can quote agent output that merely discusses network errors.
 */
export function isCodexHarnessCrash(input: {
  exitCode: number | null;
  sawProtocolEvent: boolean;
  sawProtocolTerminalEvent: boolean;
}): boolean {
  if ((input.exitCode ?? 0) === 0) return false;
  return input.sawProtocolEvent && !input.sawProtocolTerminalEvent;
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|state db returned stale rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}

function buildCodexErrorHaystack(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): string {
  return [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function classifyCodexAuthRefreshFailure(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): CodexAuthRefreshFailureClass | null {
  const haystack = buildCodexErrorHaystack(input);

  if (CODEX_REFRESH_TOKEN_REUSED_RE.test(haystack)) return "refresh_token_reused";
  if (CODEX_REFRESH_TOKEN_EXPIRED_RE.test(haystack)) return "refresh_token_expired";
  if (CODEX_REFRESH_TOKEN_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  if (CODEX_OAUTH_INVALID_GRANT_RE.test(haystack)) return "refresh_token_invalidated";
  if (CODEX_CONTEXTUAL_REFRESH_AUTH_INVALIDATED_RE.test(haystack)) return "refresh_token_invalidated";
  return null;
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseLocalClockTime(clockText: string, now: Date): Date | null {
  const normalized = clockText.trim();
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?$/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  const timeZoneHint = match[4] ?? match[5];
  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

export function extractCodexRetryNotBefore(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}, now = new Date()): Date | null {
  const haystack = buildCodexErrorHaystack(input);
  const usageLimitMatch = haystack.match(CODEX_USAGE_LIMIT_RE);
  if (!usageLimitMatch) return null;
  return parseLocalClockTime(usageLimitMatch[1] ?? "", now);
}

/**
 * ACP can preserve the provider's quota explanation as its assistant summary
 * while returning only a generic terminal failure. Keep this deliberately
 * narrower than the CLI classifier: an exact provider-shaped summary is
 * evidence, whereas quoted quota text and generic capacity messages are not.
 */
export function isCodexAcpProviderQuotaSummary(summary: string): boolean {
  const diagnostic = unwrapCodexAcpTerminalDiagnostic(summary);
  return CODEX_ACP_PROVIDER_QUOTA_SUMMARY_RE.test(diagnostic)
    || CODEX_ACP_CREDITS_QUOTA_SUMMARY_RE.test(diagnostic);
}

/** Codex's own retry-exhausted and server-overloaded sentences, same exactness rules as quota. */
export function isCodexAcpTransientUpstreamSummary(summary: string): boolean {
  return CODEX_ACP_TRANSIENT_UPSTREAM_SUMMARY_RE.test(unwrapCodexAcpTerminalDiagnostic(summary));
}

/** Every provider sentence the ACP lane may trust as a whole-output terminal diagnostic. */
export function isCodexAcpTerminalDiagnosticSummary(summary: string): boolean {
  return isCodexAcpProviderQuotaSummary(summary) || isCodexAcpTransientUpstreamSummary(summary);
}

/** The provider sentence without Codex's own warning and compaction framing. */
export function unwrapCodexAcpTerminalDiagnostic(summary: string): string {
  let diagnostic = summary.trim();
  while (CODEX_ACP_SKILLS_BUDGET_WARNING_RE.test(diagnostic)) {
    diagnostic = diagnostic.replace(CODEX_ACP_SKILLS_BUDGET_WARNING_RE, "").trim();
  }
  return diagnostic.replace(CODEX_ACP_REMOTE_COMPACT_PREFIX_RE, "").trim();
}

/**
 * Reset time of an ACP quota sentence. Codex formats it in its own local zone,
 * so callers use this only when Codex runs in this process's zone. Beyond the
 * horizon it returns null so the server keeps its bounded fallback.
 */
export function extractCodexAcpQuotaRetryNotBefore(summary: string, now = new Date()): Date | null {
  const diagnostic = unwrapCodexAcpTerminalDiagnostic(summary);
  const resetText = diagnostic.match(CODEX_ACP_CREDITS_QUOTA_SUMMARY_RE)?.[1]?.trim();
  if (!resetText) {
    const retryAt = extractCodexRetryNotBefore({ errorMessage: diagnostic }, now);
    return retryAt && isWithinCodexAcpResetHorizon(retryAt, now) ? retryAt : null;
  }
  const printed = parseCodexDatedReset(resetText) ?? parseCodexSameDayReset(resetText, now);
  if (!printed) return null;
  const ceiling = printed.getTime() + CODEX_ACP_RESET_MINUTE_CEILING_MS;
  // The provider still reports the limit, so a printed time that has already
  // passed (the reset minute itself, or clock skew) means "shortly", never
  // "tomorrow" and never "immediately".
  const retryAt = new Date(ceiling > now.getTime() ? ceiling : now.getTime() + CODEX_ACP_RESET_MINUTE_CEILING_MS);
  return isWithinCodexAcpResetHorizon(retryAt, now) ? retryAt : null;
}

function isWithinCodexAcpResetHorizon(retryAt: Date, now: Date): boolean {
  const aheadMs = retryAt.getTime() - now.getTime();
  return aheadMs > 0 && aheadMs <= CODEX_ACP_MAX_RESET_HORIZON_MS;
}

// Codex prints the time alone only for a reset later on the same local day.
function parseCodexSameDayReset(resetText: string, now: Date): Date | null {
  const match = resetText.match(CODEX_ACP_SAME_DAY_RESET_RE);
  if (!match) return null;
  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const retryAt = new Date(now);
  retryAt.setHours((hour12 % 12) + ((match[3] ?? "").toLowerCase() === "p" ? 12 : 0), minute, 0, 0);
  // Codex chose the same-day form on its own clock. Only a turn that settled
  // just after midnight can read as more than 23 h ahead; that is the day that
  // has just ended. If ambiguous, a one-minute retry is cheaper than a day.
  if (retryAt.getTime() - now.getTime() > 23 * 60 * 60 * 1000) retryAt.setDate(retryAt.getDate() - 1);
  return retryAt;
}

function parseCodexDatedReset(resetText: string): Date | null {
  const match = resetText.match(CODEX_ACP_DATED_RESET_RE);
  if (!match) return null;
  const monthIndex = MONTH_INDEX[(match[1] ?? "").slice(0, 3).toLowerCase()];
  const day = Number.parseInt(match[2] ?? "", 10);
  const year = Number.parseInt(match[3] ?? "", 10);
  const hour12 = Number.parseInt(match[4] ?? "", 10);
  const minute = Number.parseInt(match[5] ?? "", 10);
  if (monthIndex === undefined || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + ((match[6] ?? "").toLowerCase() === "p" ? 12 : 0);
  const retryAt = new Date(year, monthIndex, day, hour, minute, 0, 0);
  // Reject rolled-over dates such as "Feb 31st".
  return retryAt.getMonth() === monthIndex && retryAt.getDate() === day ? retryAt : null;
}

export function isCodexTransientUpstreamError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);

  if (isCodexProviderQuotaError(input)) return false;
  if (!CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) return false;
  // Keep automatic retries scoped to the observed remote-compaction/high-demand
  // failure shape.
  return CODEX_REMOTE_COMPACTION_RE.test(haystack) || /high\s+demand|temporary\s+errors/i.test(haystack);
}

export function isCodexProviderQuotaError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = buildCodexErrorHaystack(input);
  return CODEX_PROVIDER_QUOTA_RE.test(haystack) || extractCodexRetryNotBefore(input) != null;
}

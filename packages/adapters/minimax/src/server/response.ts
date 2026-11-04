import { asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { firstNonEmptyString } from "../shared/util.js";

export interface AssistantTurn {
  message: Record<string, unknown>;
  content: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finishReason: string | null;
}

// Extract assistant text from string content, OpenAI array-of-parts content,
// or reasoning_content — so a content-filtered or array-form response is not
// silently treated as empty output.
function extractContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        const rec = parseObject(part);
        return typeof rec.text === "string" ? rec.text : "";
      })
      .join("");
    if (joined) return joined;
  }
  const reasoning = message.reasoning_content;
  return typeof reasoning === "string" ? reasoning : "";
}

export function extractAssistantTurn(payload: Record<string, unknown>): AssistantTurn {
  const choice = Array.isArray(payload.choices) ? parseObject(payload.choices[0]) : {};
  const message = parseObject(choice.message);
  const content = extractContent(message);
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: AssistantTurn["toolCalls"] = [];
  for (const raw of rawCalls) {
    const record = parseObject(raw);
    const fn = parseObject(record.function);
    toolCalls.push({
      id: firstNonEmptyString(record.id) ?? `call_${toolCalls.length}`,
      name: firstNonEmptyString(fn.name) ?? "",
      args: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return {
    message,
    content,
    toolCalls,
    finishReason: firstNonEmptyString(choice.finish_reason),
  };
}

// MiniMax's API rejects the NEXT request with HTTP 400 ("invalid function
// arguments json string") if a prior assistant tool_call in the history carries
// arguments that aren't valid JSON — and MiniMax-M3 occasionally emits malformed
// arguments. Return a history-safe copy of the assistant message with every
// tool_call's function.arguments coerced to a valid JSON string, so one bad call
// can't poison the whole conversation and hard-fail the run. The tool result
// still reports the bad arguments back to the model, so it can correct itself.
export function sanitizeAssistantMessageForHistory(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return message;
  const safeCalls = toolCalls.map((raw) => {
    const record = parseObject(raw);
    const fn = parseObject(record.function);
    const rawArgs = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    let safeArgs = rawArgs;
    try {
      JSON.parse(rawArgs);
    } catch {
      safeArgs = "{}";
    }
    return { ...record, function: { ...fn, arguments: safeArgs } };
  });
  return { ...message, tool_calls: safeCalls };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

// Upper bounds for reported token counts. Usage comes from the upstream
// response, which for a custom baseUrl is not trusted: an absurd value
// (1e300, Infinity) must not reach the integer cost_events columns. One
// completion is capped at 10M tokens and a whole run at 100M per counter,
// far above any real MiniMax context window.
export const MAX_TOKENS_PER_RESPONSE = 10_000_000;
export const MAX_TOKENS_PER_RUN = 100_000_000;

function boundedTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_TOKENS_PER_RESPONSE, Math.max(0, Math.trunc(value)));
}

export function addBoundedTokens(total: number, delta: number): number {
  return Math.min(MAX_TOKENS_PER_RUN, total + delta);
}

// Read token usage from an OpenAI-compatible payload. Cached prompt tokens are
// reported under usage.prompt_tokens_details.cached_tokens in the schema MiniMax
// implements; a top-level usage.cached_tokens is accepted as a fallback.
// Cached tokens are a subset of the prompt, so they are clamped to inputTokens
// (the stored usage then never claims more cached than total input).
// `reported` is false when the payload carries no non-negative numeric prompt
// or completion token count; the run is then left unpriced instead of being billed $0.
export function extractUsage(payload: Record<string, unknown>): UsageTotals & { reported: boolean } {
  const usage = parseObject(payload.usage);
  const details = parseObject(usage.prompt_tokens_details);
  const rawInput = asNumber(usage.prompt_tokens, asNumber(usage.input_tokens, Number.NaN));
  const rawOutput = asNumber(usage.completion_tokens, asNumber(usage.output_tokens, Number.NaN));
  const reported = (Number.isFinite(rawInput) && rawInput >= 0) || (Number.isFinite(rawOutput) && rawOutput >= 0);
  const inputTokens = boundedTokenCount(rawInput);
  return {
    inputTokens,
    outputTokens: boundedTokenCount(rawOutput),
    cachedInputTokens: Math.min(
      inputTokens,
      boundedTokenCount(asNumber(details.cached_tokens, asNumber(usage.cached_tokens, 0))),
    ),
    reported,
  };
}

// MiniMax reports some API errors (rate limit, insufficient balance, auth)
// as HTTP 200 with a non-zero base_resp.status_code and no choices. Returns
// the error when present, null for success (status_code 0 or absent).
export interface MiniMaxBaseRespError {
  statusCode: number;
  statusMsg: string;
}

export function readBaseRespError(payload: Record<string, unknown>): MiniMaxBaseRespError | null {
  const baseResp = parseObject(payload.base_resp);
  const code = asNumber(baseResp.status_code, 0);
  if (!Number.isFinite(code) || code === 0) return null;
  return {
    statusCode: Math.trunc(code),
    statusMsg: typeof baseResp.status_msg === "string" ? baseResp.status_msg : "",
  };
}

// Classification of MiniMax base_resp status codes (MiniMax API error-code
// reference): 1002 = rate limit (RPM), 1039 = token rate limit (TPM) ->
// provider_quota; 1000 = unknown error, 1001 = request timeout, 1013 =
// internal service error -> transient_upstream. Everything else (1004 auth,
// 1008 insufficient balance, 2013 invalid params, 1026/1027 content safety,
// ...) is a non-retryable failure.
export function classifyBaseRespError(
  statusCode: number,
): "provider_quota" | "transient_upstream" | null {
  if (statusCode === 1002 || statusCode === 1039) return "provider_quota";
  if (statusCode === 1000 || statusCode === 1001 || statusCode === 1013) return "transient_upstream";
  return null;
}

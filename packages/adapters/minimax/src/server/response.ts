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

// Read token usage from an OpenAI-compatible payload. Cached prompt tokens are
// reported under usage.prompt_tokens_details.cached_tokens in the schema MiniMax
// implements; a top-level usage.cached_tokens is accepted as a fallback.
export function extractUsage(payload: Record<string, unknown>): UsageTotals {
  const usage = parseObject(payload.usage);
  const details = parseObject(usage.prompt_tokens_details);
  return {
    inputTokens: Math.max(
      0,
      Math.trunc(asNumber(usage.prompt_tokens, asNumber(usage.input_tokens, 0))),
    ),
    outputTokens: Math.max(
      0,
      Math.trunc(asNumber(usage.completion_tokens, asNumber(usage.output_tokens, 0))),
    ),
    cachedInputTokens: Math.max(
      0,
      Math.trunc(asNumber(details.cached_tokens, asNumber(usage.cached_tokens, 0))),
    ),
  };
}

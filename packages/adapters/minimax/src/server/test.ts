import { parseObject, redactCommandTextForLogs } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { resolveBaseUrl, validateBaseUrlForCredential } from "../shared/base-url.js";
import { resolveMiniMaxCredential } from "../shared/credentials.js";
import { isRedirectResponse, NO_REDIRECT, readResponseTextCapped } from "../shared/http.js";
import { resolveMiniMaxModel } from "../shared/model.js";
import { firstNonEmptyString } from "../shared/util.js";
import { readBaseRespError } from "./response.js";
import { stripThinkBlocks } from "../shared/text.js";

const PROBE_TIMEOUT_MS = 45_000;
// The probe only needs a tiny completion; anything larger is refused.
const PROBE_MAX_RESPONSE_BYTES = 256 * 1024;

function truncate(text: unknown, limit = 500): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const testedAt = new Date().toISOString();
  const config = parseObject(ctx.config);

  // Same credential + baseUrl resolution as execute(), so the pre-run gate and
  // the real run never disagree — and the probe cannot be used to exfiltrate
  // the host key to a tenant-controlled endpoint.
  const credential = await resolveMiniMaxCredential(config);
  if (!credential.ok) {
    return {
      adapterType: "minimax_local",
      status: "fail",
      testedAt,
      checks: [
        {
          code: "minimax_credentials",
          level: "error",
          message: credential.reason,
          hint: "Set env.MINIMAX_API_KEY on the agent (e.g. a secret reference).",
        },
      ],
    };
  }

  const resolvedBaseUrl = resolveBaseUrl(config);
  const baseUrlError = validateBaseUrlForCredential(resolvedBaseUrl, credential.credential.source);
  if (baseUrlError) {
    return {
      adapterType: "minimax_local",
      status: "fail",
      testedAt,
      checks: [
        { code: "minimax_credentials", level: "info", message: "MiniMax API credentials are configured." },
        { code: "minimax_base_url", level: "error", message: baseUrlError },
      ],
    };
  }

  // Same model resolution as execute(): primaryModel overrides model.
  const model = resolveMiniMaxModel(config);
  const endpoint = `${resolvedBaseUrl.baseUrl}/chat/completions`;

  const checks: AdapterEnvironmentTestResult["checks"] = [
    {
      code: "minimax_credentials",
      level: "info",
      message: "MiniMax API credentials are configured.",
      detail: `Credential source: ${credential.credential.source === "company" ? "agent config" : "host environment"}.`,
    },
  ];

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are responding to a Paperclip adapter health check. Do not include reasoning, markdown, XML, or <think> tags. Return exactly the two letters OK.",
      },
      { role: "user", content: "Return exactly: OK" },
    ],
    temperature: 0,
    max_tokens: 128,
    max_completion_tokens: 128,
  };

  // Probe details are shown in the UI. They must never echo the raw upstream
  // body (a custom loopback baseUrl could otherwise be used to read arbitrary
  // local HTTP endpoints back through the probe) and are always redacted.
  const apiKey = credential.credential.key;
  const redact = (text: unknown): string => {
    const redacted = redactCommandTextForLogs(String(text ?? ""));
    return truncate(apiKey ? redacted.split(apiKey).join("***REDACTED***") : redacted, 300);
  };
  // Only a structured error message field is surfaced, never the body itself.
  const describeErrorBody = (text: string): string => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = parseObject(JSON.parse(text));
    } catch {
      return `Response body was not JSON (${text.length} characters); body not shown.`;
    }
    const errorRecord = parseObject(parsed.error);
    const baseResp = readBaseRespError(parsed);
    const message = firstNonEmptyString(
      errorRecord.message,
      typeof parsed.error === "string" ? parsed.error : null,
      parsed.message,
      baseResp?.statusMsg,
    );
    return message ? `Upstream error: ${redact(message)}` : "Response carried no error message.";
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.credential.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: NO_REDIRECT,
    });

    if (isRedirectResponse(response)) {
      await response.body?.cancel().catch(() => {});
      checks.push({
        code: "minimax_completion",
        level: "error",
        message: `MiniMax API probe got a redirect (HTTP ${response.status}); redirects are not followed.`,
        hint: "Point baseUrl at the final endpoint.",
      });
      return { adapterType: "minimax_local", status: "fail", testedAt, checks };
    }

    const read = await readResponseTextCapped(response, {
      maxBytes: PROBE_MAX_RESPONSE_BYTES,
      signal: controller.signal,
    });
    if (!read.ok) {
      checks.push({
        code: "minimax_completion",
        level: "error",
        message:
          read.reason === "aborted"
            ? `MiniMax API probe timed out after ${PROBE_TIMEOUT_MS / 1000}s.`
            : read.reason === "too_large"
              ? `MiniMax API probe response exceeded ${PROBE_MAX_RESPONSE_BYTES} bytes.`
              : "MiniMax API probe response could not be read.",
        ...(read.message ? { detail: redact(read.message) } : {}),
      });
      return { adapterType: "minimax_local", status: "fail", testedAt, checks };
    }
    const text = read.text;

    if (!response.ok) {
      checks.push({
        code: "minimax_completion",
        level: "error",
        message: `MiniMax API probe failed with HTTP ${response.status}.`,
        detail: describeErrorBody(text),
      });
      return { adapterType: "minimax_local", status: "fail", testedAt, checks };
    }

    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      checks.push({
        code: "minimax_completion",
        level: "error",
        message: "MiniMax API returned non-JSON output.",
        detail: describeErrorBody(text),
      });
      return { adapterType: "minimax_local", status: "fail", testedAt, checks };
    }

    const payload = parseObject(json);
    const baseRespError = readBaseRespError(payload);
    if (baseRespError) {
      checks.push({
        code: "minimax_completion",
        level: "error",
        message: `MiniMax API probe failed with error ${baseRespError.statusCode}.`,
        detail: describeErrorBody(text),
      });
      return { adapterType: "minimax_local", status: "fail", testedAt, checks };
    }
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
      checks.push({
        code: "minimax_completion",
        level: "error",
        message: "MiniMax API returned HTTP 200 without a completion.",
        detail: describeErrorBody(text),
      });
      return { adapterType: "minimax_local", status: "fail", testedAt, checks };
    }
    const choice = Array.isArray(payload.choices) ? parseObject(payload.choices[0]) : {};
    const message = parseObject(choice.message);
    const raw = typeof message.content === "string" ? message.content : "";
    const cleaned = stripThinkBlocks(raw);
    const exactOk = /^OK[.!]?$/i.test(cleaned);

    checks.push({
      code: "minimax_completion",
      level: "info",
      message: exactOk
        ? "MiniMax API completion probe succeeded."
        : "MiniMax API authenticated and returned a completion response.",
      detail: exactOk
        ? `Model: ${model}`
        : `Probe response was non-OK after stripping reasoning; not treated as credential failure. Sanitized response: ${redact(cleaned || raw)}`,
    });

    return { adapterType: "minimax_local", status: "pass", testedAt, checks };
  } catch (error) {
    const aborted = (error as Error).name === "AbortError";
    checks.push({
      code: "minimax_completion",
      level: "error",
      message: aborted
        ? `MiniMax API probe timed out after ${PROBE_TIMEOUT_MS / 1000}s.`
        : "MiniMax API probe failed.",
      detail: redact(error instanceof Error ? error.message : String(error)),
    });
    return { adapterType: "minimax_local", status: "fail", testedAt, checks };
  } finally {
    clearTimeout(timeout);
  }
}

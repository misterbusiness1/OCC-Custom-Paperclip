import type { AdapterExecutionResult } from "../types.js";

const ACP_TRANSIENT_RATE_LIMIT_RE = /(?:\b429\b|rate[ -]?limit(?:ed|ing)?|too many requests)/i;
const ACP_HARD_AUTH_FAILURE_RE =
  /(?:\b401\b|unauthori[sz]ed|authori[sz]ation failed|authentication[\s_-](?:error|failed)|invalid_grant|login required|not logged in|(?:missing|invalid|expired|revoked)\s+(?:api[ _-]?)?(?:key|token|credential)s?|(?:api[ _-]?)?(?:key|token|credential)s?\s+(?:is\s+)?(?:missing|invalid|expired|revoked))/i;
const KIMI_WRAPPED_FIVE_HOUR_QUOTA_RE =
  /^Authentication required:\s*403\s+You(?:'|’)ve reached your 5-hour usage limit\.\s*Your quota will reset when the current 5-hour window ends\.(?:\s+To continue now, purchase extra usage or upgrade your plan:\s*https:\/\/www\.kimi\.com\/membership\/subscription\?tab=quota)?$/i;

export const ACP_WRAPPED_QUOTA_RETRY_DELAY_MS = 5 * 60 * 60 * 1000;

export function classifyAcpTerminalFailure(
  message: string,
  nowMs = Date.now(),
): Pick<AdapterExecutionResult, "errorCode" | "errorFamily" | "retryNotBefore"> {
  const normalized = message.trim();

  // This is the one observed ACP wrapper that lies about authentication. Keep
  // the exception anchored so mixed or merely similar auth failures cannot be
  // converted into scheduled quota retries.
  if (KIMI_WRAPPED_FIVE_HOUR_QUOTA_RE.test(normalized)) {
    return {
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: new Date(nowMs + ACP_WRAPPED_QUOTA_RETRY_DELAY_MS).toISOString(),
    };
  }
  if (ACP_HARD_AUTH_FAILURE_RE.test(normalized) || /authentication required/i.test(normalized)) {
    return { errorCode: "acpx_auth_required", errorFamily: null, retryNotBefore: null };
  }
  // A 429 is a transient throttle even when its text also says quota or limit.
  if (ACP_TRANSIENT_RATE_LIMIT_RE.test(normalized)) {
    return {
      errorCode: "acpx_transient_upstream",
      errorFamily: "transient_upstream",
      retryNotBefore: null,
    };
  }
  // Leave ordinary provider-quota text on the existing generic path. Server
  // finalization already normalizes that path, including provider reset-time
  // parsing and its ordinary bounded backoff; only the explicit Kimi wrapper
  // above needs an adapter-owned five-hour timestamp.
  return { errorCode: "acpx_turn_failed", errorFamily: null, retryNotBefore: null };
}

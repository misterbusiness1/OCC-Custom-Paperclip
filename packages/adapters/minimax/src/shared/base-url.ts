import { DEFAULT_MINIMAX_LOCAL_BASE_URL } from "../constants.js";
import { firstNonEmptyString, normalizeBaseUrl } from "./util.js";

export const DEFAULT_BASE_URL = normalizeBaseUrl(DEFAULT_MINIMAX_LOCAL_BASE_URL);

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

const DEFAULT_HOST = hostOf(DEFAULT_MINIMAX_LOCAL_BASE_URL);

// Operator-configured allowlist of extra hosts permitted for a custom baseUrl
// (comma-separated). Empty by default: only the canonical MiniMax host is
// allowed unless an operator opts in.
function operatorAllowedHosts(): Set<string> {
  const raw = process.env.MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isLocalHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

export interface ResolvedBaseUrl {
  baseUrl: string;
  isDefault: boolean;
  host: string | null;
}

export function resolveBaseUrl(config: Record<string, unknown>): ResolvedBaseUrl {
  const raw = firstNonEmptyString(config.baseUrl);
  if (!raw) {
    return { baseUrl: DEFAULT_BASE_URL, isDefault: true, host: DEFAULT_HOST };
  }
  const baseUrl = normalizeBaseUrl(raw);
  const host = hostOf(baseUrl);
  return { baseUrl, isDefault: host !== null && host === DEFAULT_HOST, host };
}

// Guard against key exfiltration through a tenant-controlled baseUrl. Returns
// null when the (baseUrl, credential source) pair is safe, or an error message
// to fail the run/probe with.
//
// Rules for a NON-default baseUrl:
//   - must be a parseable URL,
//   - must be https (except a local host, for on-box proxies/testing),
//   - if an operator allowlist is set, its host must be listed,
//   - must NOT be paired with the host/process.env credential — a custom
//     endpoint must use a company-scoped MINIMAX_API_KEY so the shared host
//     key is never sent to an arbitrary URL.
export function validateBaseUrlForCredential(
  resolved: ResolvedBaseUrl,
  credentialSource: "company" | "host",
): string | null {
  if (resolved.isDefault) return null;

  const host = resolved.host;
  if (!host) {
    return `Invalid MiniMax baseUrl: "${resolved.baseUrl}".`;
  }
  const local = isLocalHost(host);
  if (!local && !resolved.baseUrl.startsWith("https://")) {
    return `Custom MiniMax baseUrl must use https (got "${resolved.baseUrl}").`;
  }
  const allowed = operatorAllowedHosts();
  if (!local && allowed.size > 0 && !allowed.has(host)) {
    return `MiniMax baseUrl host "${host}" is not permitted (set MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS to allow it).`;
  }
  if (credentialSource === "host") {
    return (
      `Refusing to send the shared host MiniMax API key to a non-default baseUrl ("${host}"). ` +
      "Configure a company-scoped env.MINIMAX_API_KEY when using a custom endpoint."
    );
  }
  return null;
}

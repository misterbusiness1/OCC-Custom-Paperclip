import net from "node:net";
import { DEFAULT_MINIMAX_LOCAL_BASE_URL } from "../constants.js";
import { firstNonEmptyString, normalizeBaseUrl } from "./util.js";

export const DEFAULT_BASE_URL = normalizeBaseUrl(DEFAULT_MINIMAX_LOCAL_BASE_URL);

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  return parseUrl(url)?.host.toLowerCase() ?? null;
}

const DEFAULT_HOST = hostOf(DEFAULT_MINIMAX_LOCAL_BASE_URL);

// A baseUrl must be a plain origin + path. A query string or fragment would
// neutralise the "/chat/completions" suffix the adapter appends (e.g.
// "http://host/secret?x=" turns the request into GET-able "secret?x=/chat/..."),
// and embedded userinfo would be sent as credentials. A bare trailing "?" or
// "#" parses to an empty search/hash, so the raw string is checked too.
function hasDisallowedUrlParts(raw: string, parsed: URL): boolean {
  return raw.includes("?") || raw.includes("#") || parsed.username !== "" || parsed.password !== "";
}

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

// Loopback means an exact loopback name or IP LITERAL. A prefix match on
// "127." would also accept DNS names such as "127.attacker.example" or
// "127.0.0.1.nip.io", which resolve anywhere.
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (bare === "localhost") return true;
  const family = net.isIP(bare);
  if (family === 4) return bare.split(".")[0] === "127";
  if (family === 6) return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
  return false;
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
  const parsed = parseUrl(baseUrl);
  const host = parsed ? parsed.host.toLowerCase() : null;
  // "Default" requires the canonical host AND https AND no query/fragment/
  // userinfo. Only a default URL may receive the shared host key, so a
  // scheme downgrade (http://api.minimax.io) must NOT count as default.
  const isDefault =
    parsed !== null &&
    host === DEFAULT_HOST &&
    parsed.protocol === "https:" &&
    !hasDisallowedUrlParts(baseUrl, parsed);
  return { baseUrl, isDefault, host };
}

// Guard against key exfiltration through a tenant-controlled baseUrl. Returns
// null when the (baseUrl, credential source) pair is safe, or an error message
// to fail the run/probe with.
//
// Rules for a NON-default baseUrl:
//   - must be a parseable http(s) URL with no query, fragment or userinfo,
//   - must be https (except a loopback IP literal or "localhost", for on-box
//     proxies/testing),
//   - if an operator allowlist is set, its host must be listed (this applies
//     to loopback hosts too),
//   - must NOT be paired with the host/process.env credential — a custom
//     endpoint must use a company-scoped MINIMAX_API_KEY so the shared host
//     key is never sent to an arbitrary URL.
export function validateBaseUrlForCredential(
  resolved: ResolvedBaseUrl,
  credentialSource: "company" | "host",
): string | null {
  if (resolved.isDefault) return null;

  const parsed = parseUrl(resolved.baseUrl);
  const host = resolved.host;
  if (!parsed || !host || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return `Invalid MiniMax baseUrl: "${resolved.baseUrl}".`;
  }
  if (hasDisallowedUrlParts(resolved.baseUrl, parsed)) {
    return "MiniMax baseUrl must not contain a query string, fragment or credentials.";
  }
  const local = isLoopbackHostname(parsed.hostname);
  if (!local && parsed.protocol !== "https:") {
    return `Custom MiniMax baseUrl must use https (got "${resolved.baseUrl}").`;
  }
  const allowed = operatorAllowedHosts();
  if (allowed.size > 0 && !allowed.has(host) && !allowed.has(parsed.hostname.toLowerCase())) {
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

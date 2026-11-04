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

// Operator-configured allowlist of hosts permitted for a custom baseUrl
// (comma-separated). Empty by default. When it is empty, any public https
// host (and loopback) is accepted for a company key; private, link-local and
// other non-public IP LITERALS are refused (see isNonPublicIpLiteral). DNS
// names are not resolved, so a public-looking name that resolves to a private
// address is NOT caught here; operators who need a strict posture set this
// allowlist. When it is set, only the listed hosts are accepted.
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

// Non-public address ranges that a custom baseUrl may not target as an IP
// literal unless the operator allowlists that host: private (RFC 1918),
// carrier-grade NAT, link-local (incl. cloud metadata at 169.254.169.254),
// "this network", benchmarking, multicast/reserved, IPv6 unique-local,
// link-local and unspecified. Loopback is handled separately (it is the
// documented on-box proxy/testing exception).
const NON_PUBLIC_RANGES = (() => {
  const list = new net.BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.0.0.0", 24, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("198.18.0.0", 15, "ipv4");
  list.addSubnet("224.0.0.0", 3, "ipv4");
  list.addAddress("::", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  return list;
})();

// IPv4-mapped IPv6 literals (::ffff:a.b.c.d, which WHATWG URL normalises to
// ::ffff:xxxx:yyyy) are mapped back to IPv4 so they cannot side-step the check.
function mappedIpv4(bareV6: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bareV6);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bareV6);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

export function isNonPublicIpLiteral(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = net.isIP(bare);
  if (family === 4) return NON_PUBLIC_RANGES.check(bare, "ipv4");
  if (family === 6) {
    const v4 = mappedIpv4(bare);
    if (v4) return isLoopbackHostname(v4) || NON_PUBLIC_RANGES.check(v4, "ipv4");
    return NON_PUBLIC_RANGES.check(bare, "ipv6");
  }
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
//   - with no allowlist, a private/link-local/other non-public IP literal is
//     refused (an allowlisted host is accepted whatever its address),
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
  const listed = allowed.has(host) || allowed.has(parsed.hostname.toLowerCase());
  if (allowed.size > 0 && !listed) {
    return `MiniMax baseUrl host "${host}" is not permitted (set MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS to allow it).`;
  }
  if (!listed && isNonPublicIpLiteral(parsed.hostname)) {
    return (
      `MiniMax baseUrl host "${host}" is a private, link-local or otherwise non-public address; ` +
      "list it in MINIMAX_LOCAL_ALLOWED_BASE_URL_HOSTS to allow it."
    );
  }
  if (credentialSource === "host") {
    return (
      `Refusing to send the shared host MiniMax API key to a non-default baseUrl ("${host}"). ` +
      "Configure a company-scoped env.MINIMAX_API_KEY when using a custom endpoint."
    );
  }
  return null;
}

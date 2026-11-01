import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";

const DEFAULT_DNS_TIMEOUT_MS = 5_000;

type LookupResult = { address: string; family: number };

export type RemoteHttpEndpointLookup = (hostname: string) => Promise<LookupResult[]>;

export type RemoteHttpEndpointGuardOptions = {
  allowPrivateNetwork?: boolean;
  dnsTimeoutMs?: number;
  lookup?: RemoteHttpEndpointLookup;
};

export type RemoteHttpEndpointErrorFactory = (message: string, code: string) => Error;

export function parseRemoteHttpEndpoint(
  value: unknown,
  error: RemoteHttpEndpointErrorFactory,
): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw error("Remote MCP connection requires config.url", "mcp_remote_url_missing");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw error("Remote MCP connection URL is invalid", "mcp_remote_url_invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw error("Remote MCP connection URL must use http or https", "mcp_remote_url_invalid");
  }
  return parsed;
}

export async function assertPublicRemoteHttpEndpoint(
  endpoint: URL,
  options: RemoteHttpEndpointGuardOptions,
  error: RemoteHttpEndpointErrorFactory,
): Promise<void> {
  if (options.allowPrivateNetwork) return;

  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw error("Remote MCP connection URL cannot target private or reserved network addresses", "remote_http_private_endpoint");
  }

  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      throw error("Remote MCP connection URL cannot target private or reserved network addresses", "remote_http_private_endpoint");
    }
    return;
  }

  let results: LookupResult[];
  try {
    results = await lookupWithTimeout(
      hostname,
      options.lookup ?? defaultLookup,
      options.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
    );
  } catch {
    throw error("Remote MCP connection hostname could not be resolved", "remote_http_dns_failed");
  }
  if (results.length === 0) {
    throw error("Remote MCP connection hostname did not resolve", "remote_http_dns_failed");
  }
  if (results.some((result) => isPrivateOrReservedIp(result.address))) {
    throw error("Remote MCP connection URL cannot resolve to private or reserved network addresses", "remote_http_private_endpoint");
  }
}

/**
 * Fetch with the public-address policy enforced at socket DNS resolution, not
 * only in a preflight lookup. The checked addresses are passed directly to the
 * connector, so a second DNS answer cannot redirect credentials to a private
 * host. Every request uses its own dispatcher; redirects must be handled and
 * checked by the caller rather than followed inside fetch.
 */
export async function fetchRemoteHttpEndpoint(
  endpoint: URL,
  init: RequestInit,
  options: RemoteHttpEndpointGuardOptions,
  error: RemoteHttpEndpointErrorFactory,
): Promise<Response> {
  await assertPublicRemoteHttpEndpoint(endpoint, options, error);
  const requestInit = {
    ...init,
    redirect: init.redirect === "error" ? "error" as const : "manual" as const,
    // Existing MCP/cloud callers supply their own execution deadlines. OAuth
    // metadata/token requests without one still need bounded socket lifetime,
    // including when an upstream sends headers but never finishes its body.
    signal: init.signal ?? AbortSignal.timeout(30_000),
  };
  if (options.allowPrivateNetwork) return fetch(endpoint.toString(), requestInit);

  let connectionPolicyError: Error | undefined;
  const socketError: RemoteHttpEndpointErrorFactory = (message, code) => {
    connectionPolicyError = error(message, code);
    return connectionPolicyError;
  };
  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    // Reuse the same address classifier at connection time, but retain the
    // actual checked results instead of asking the OS to resolve them again.
    let resolved: LookupResult[] = [];
    const resolve = options.lookup ?? defaultLookup;
    void assertPublicRemoteHttpEndpoint(endpoint, {
      ...options,
      lookup: async (requestedHostname) => {
        if (requestedHostname !== hostname.toLowerCase()) {
          throw new Error("Unexpected remote endpoint hostname");
        }
        resolved = await resolve(requestedHostname);
        return resolved;
      },
    }, socketError).then(() => {
      const family = lookupOptions.family;
      const addresses = family === 4 || family === 6
        ? resolved.filter((entry) => entry.family === family)
        : resolved;
      if (addresses.length === 0) {
        callback(socketError("Remote MCP connection hostname did not resolve", "remote_http_dns_failed"), "");
      } else if (lookupOptions.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    }, (cause: Error) => callback(cause, ""));
  };
  const dispatcher = new Agent({ connect: { lookup } });
  try {
    // Node's built-in fetch supports undici dispatchers, though DOM's
    // RequestInit intentionally does not declare this Node-specific field.
    return await fetch(endpoint.toString(), { ...requestInit, dispatcher } as RequestInit);
  } catch (cause) {
    // fetch wraps connector failures in TypeError. Preserve the same HTTP
    // status/code as a preflight policy denial rather than turning it into 500.
    if (connectionPolicyError) throw connectionPolicyError;
    throw cause;
  } finally {
    // close waits for the response stream without preventing the caller from
    // consuming it; there is no reusable connection to another request.
    void dispatcher.close().catch(() => dispatcher.destroy());
  }
}

function defaultLookup(hostname: string): Promise<LookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

async function lookupWithTimeout(hostname: string, lookup: RemoteHttpEndpointLookup, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`DNS lookup timed out for ${hostname}`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isPrivateOrReservedIp(address: string): boolean {
  const lower = address.toLowerCase();
  const mappedIpv4 = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4?.[1]) return isPrivateOrReservedIpv4(mappedIpv4[1]);
  const mappedIpv4Hex = parseMappedIpv4Hex(lower);
  if (mappedIpv4Hex) return isPrivateOrReservedIpv4(mappedIpv4Hex);
  if (isIP(address) === 4) return isPrivateOrReservedIpv4(address);
  if (isIP(address) === 6) return isPrivateOrReservedIpv6(lower);
  return true;
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const octets = parseIpv4Address(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseIpv4Address(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parsed as [number, number, number, number];
}

function parseMappedIpv4Hex(address: string): string | null {
  const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const hi = Number.parseInt(match[1]!, 16);
  const lo = Number.parseInt(match[2]!, 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateOrReservedIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(address)) return true;
  if (address.startsWith("ff")) return true;
  if (address === "100::" || address.startsWith("100:")) return true;
  if (/^2001:(?:0{0,4}:|:)/.test(address)) return true;
  if (address.startsWith("2001:db8:") || address === "2001:db8::") return true;
  if (address.startsWith("2001:2:") || address === "2001:2::") return true;
  if (/^2001:0?2[0-9a-f]:/.test(address)) return true;
  if (address.startsWith("2002:")) return true;
  if (address.startsWith("64:ff9b:")) return true;
  return false;
}

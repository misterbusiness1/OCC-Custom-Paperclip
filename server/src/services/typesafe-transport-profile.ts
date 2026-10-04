import { constants, lstatSync, openSync, closeSync, readFileSync, fstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { resolveApprovedRemoteHttpAddresses, isPrivateOrReservedIp } from "./remote-http-endpoint-guard.js";

export const TYPESAFE_TRANSPORT_ENV = "PAPERCLIP_TYPESAFE_WORKER_TRANSPORT";
const OFFICIAL_ORIGIN = "https://api.typesafe.ai";
const OPERATOR_ROOT = "/etc/paperclip/typesafe-transport";
const MAX_CA_BYTES = 64 * 1024;
export type TypeSafeTransportPolicy = { baseURL: string; caPem?: string; fixtureAddress?: string };

function invalid(): never { throw new Error("Invalid operator TypeSafe transport profile"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function origin(value: unknown): string {
  if (typeof value !== "string") invalid();
  let url: URL;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || value !== url.origin) invalid();
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || isIP(url.hostname.replace(/^\[|\]$/g, ""))) invalid();
  return url.origin;
}
function fixtureAddress(value: unknown): string {
  if (typeof value !== "string" || isIP(value) === 0) invalid();
  const parts = value.split(".").map(Number);
  const privateV4 = isIP(value) === 4 && (parts[0] === 10 || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) || (parts[0] === 192 && parts[1] === 168));
  if (!privateV4 && isPrivateOrReservedIp(value)) invalid();
  return value;
}

// No symlink in the allowlisted directory or any path below it. Open the final
// file without following links and read that descriptor, not a second path.
function operatorFile(filename: unknown, root: string, maxBytes: number, ownerUid: number): string {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || !path.isAbsolute(root)) invalid();
  const resolved = path.resolve(filename);
  if (resolved !== filename || !resolved.startsWith(path.resolve(root) + path.sep)) invalid();
  let current = path.parse(resolved).root;
  for (const segment of resolved.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (current === resolved ? !info.isFile() : !info.isDirectory())) invalid();
    if (current === root || current.startsWith(root + path.sep)) {
      if (info.mode & 0o022 || info.uid !== ownerUid) invalid();
    }
  }
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes || stat.mode & 0o022 || stat.uid !== ownerUid) invalid();
    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) invalid();
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

/** Read once at loader startup. Only deployment environment selects this policy. */
export function loadTypeSafeTransportPolicy(env: NodeJS.ProcessEnv = process.env, operatorRoot = OPERATOR_ROOT, ownerUid = 0): TypeSafeTransportPolicy {
  const file = env.PAPERCLIP_TYPESAFE_TRANSPORT_PROFILE;
  const fixture = env.PAPERCLIP_TYPESAFE_QUALIFICATION_FIXTURE;
  if (!file && !fixture) return { baseURL: OFFICIAL_ORIGIN };
  if (!file || !fixture || env.PAPERCLIP_TYPESAFE_TRANSPORT_MODE !== "isolated_qualification"
    || env.PAPERCLIP_DEPLOYMENT_EXPOSURE !== "private") invalid();
  try {
    const profile = record(JSON.parse(operatorFile(file, operatorRoot, 4096, ownerUid)));
    const policy = record(JSON.parse(fixture));
    exactKeys(profile, ["baseURL", "caBundlePath"]); exactKeys(policy, ["origin", "address"]);
    const baseURL = origin(profile.baseURL);
    if (baseURL !== origin(policy.origin)) invalid();
    const address = fixtureAddress(policy.address);
    let caPem: string | undefined;
    if (profile.caBundlePath !== undefined) {
      caPem = operatorFile(profile.caBundlePath, operatorRoot, MAX_CA_BYTES, ownerUid);
      const certificates = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
      if (!certificates.length || caPem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) invalid();
      for (const pem of certificates) {
        const cert = new X509Certificate(pem);
        if (!cert.ca || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) invalid();
      }
    }
    return { baseURL, fixtureAddress: address, ...(caPem ? { caPem } : {}) };
  } catch { invalid(); }
}

/** Trusted package/origin checks precede delivery of any operator trust material. */
export async function typeSafeWorkerTransportEnv(policy: TypeSafeTransportPolicy, input: {
  manifestId: string; packageName?: string; packagePath?: string | null; trustedPackagePath: string;
}, lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>): Promise<Record<string, string>> {
  if (input.manifestId !== "oxford.typesafe-skill-suggestion" || input.packageName !== "@paperclipai/plugin-typesafe-skill-suggestion" || !input.packagePath) return {};
  try {
    if (path.resolve(input.packagePath) !== realpathSync(input.packagePath)
      || realpathSync(input.packagePath) !== realpathSync(input.trustedPackagePath)) return {};
  } catch { return {}; }
  const addresses = policy.fixtureAddress ? [policy.fixtureAddress]
    : await resolveApprovedRemoteHttpAddresses(new URL(policy.baseURL), { lookup }, () => new Error("TypeSafe transport destination denied"));
  return { [TYPESAFE_TRANSPORT_ENV]: JSON.stringify({ baseURL: policy.baseURL, addresses, caPem: policy.caPem ?? null }) };
}

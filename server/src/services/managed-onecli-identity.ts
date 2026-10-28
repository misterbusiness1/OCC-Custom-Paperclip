import { forbidden, unprocessable } from "../errors.js";

/** Server-owned assignment. These fields are never accepted from adapter env. */
export const ONECLI_IDENTITY_METADATA = "paperclipOnecliIdentity";
export const ONECLI_IDENTITY_PATH = "access.paperclip_onecli_identity";
const RESERVED_ENV = new Set([
  "ONECLI_AGENT_TOKEN",
  "ONECLI_AGENT",
  "ONECLI_API_KEY",
  "ONECLI_API_BASE_URL",
  "ONECLI_BASE_URL",
  "ONECLI_URL",
  "ONECLI_HOST",
  "ONECLI_API_HOST",
  "ONECLI_GATEWAY_HOST",
  "ONECLI_CONFIG",
  "ONECLI_HOME",
]);
export type AssignedOnecliIdentity = {
  version: 1;
  companyId: string;
  agentId: string;
  environmentId: string;
  id: string;
  identifier: string;
  projectId: string;
  organizationId: string;
};
const fields = [
  "companyId",
  "agentId",
  "environmentId",
  "id",
  "identifier",
  "projectId",
  "organizationId",
] as const;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function hasOnecliIdentity(metadata: unknown): boolean {
  return Object.hasOwn(record(metadata), ONECLI_IDENTITY_METADATA);
}
export function parseOnecliIdentity(metadata: unknown): AssignedOnecliIdentity {
  const value = record(record(metadata)[ONECLI_IDENTITY_METADATA]);
  if (
    value.version !== 1 ||
    Object.keys(value).length !== fields.length + 1 ||
    fields.some(
      (key) =>
        typeof value[key] !== "string" ||
        !String(value[key]).trim() ||
        String(value[key]).trim() !== value[key],
    )
  ) {
    throw unprocessable("Managed OneCLI identity metadata is invalid");
  }
  return { ...value } as AssignedOnecliIdentity;
}
export function isReservedOnecliPath(path: string): boolean {
  return (
    path === ONECLI_IDENTITY_PATH ||
    (path.startsWith("env.") &&
      (RESERVED_ENV.has(path.slice(4)) || path.slice(4).startsWith("ONECLI_")))
  );
}
export function scrubOnecliEnv(env: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record(env)).filter(
      ([key]) => !RESERVED_ENV.has(key) && !key.startsWith("ONECLI_"),
    ),
  );
}
/** Generic configuration/proposals cannot designate or expose a canonical identity. */
export function assertOrdinaryOnecliBinding(
  metadata: unknown,
  path: string,
): void {
  if (hasOnecliIdentity(metadata) || isReservedOnecliPath(path)) {
    throw forbidden(
      "Managed OneCLI identity bindings require the company owner assignment path",
    );
  }
}
export type ManagedOnecliProjectionInput = {
  companyId: string;
  agentId: string;
  runId: string;
  environmentId: string;
  driver: string;
  executionTarget: {
    kind?: string;
    transport?: string;
    providerKey?: string | null;
    environmentId?: string | null;
    leaseId?: string | null;
  } | null;
  /** Supplied only by the control-plane operator, never adapter configuration. */
  trustedApiBase: string;
};
export type ManagedOnecliProjectionDependencies = {
  loadRun: () => Promise<{
    id: string;
    companyId: string;
    agentId: string;
    status: string;
  } | null>;
  loadLease: () => Promise<{
    id: string;
    companyId: string;
    environmentId: string | null;
    heartbeatRunId: string | null;
    status: string;
    provider: string | null;
    providerLeaseId: string | null;
    releasedAt: unknown;
    metadata: unknown;
  } | null>;
  loadAssignment: () => Promise<{
    companyId: string;
    targetType: string;
    targetId: string;
    configPath: string;
    secretId: string;
    required: boolean;
    versionSelector: string;
    secret: {
      companyId: string;
      scope: string;
      provider: string;
      latestVersion: number;
      status: string;
      deletedAt: unknown;
      providerMetadata: unknown;
    };
  } | null>;
  resolveSecret: (secretId: string, version: number) => Promise<string>;
  registerForRedaction: (value: string) => void;
  /** Native fetch in production; response bodies and errors must never be logged. */
  fetch: typeof fetch;
};
export async function resolveManagedOnecliProjection(
  input: ManagedOnecliProjectionInput,
  deps: ManagedOnecliProjectionDependencies,
): Promise<{ env: Record<string, string>; secretKeys: string[] }> {
  const refuse = () => {
    throw unprocessable("Managed OneCLI assignment could not be verified", {
      code: "managed_onecli_assignment_invalid",
    });
  };
  // Do not read credentials until the actual realized worker and locked run match.
  if (
    input.driver !== "sandbox" ||
    !input.executionTarget ||
    input.executionTarget.kind !== "remote" ||
    input.executionTarget.transport !== "sandbox" ||
    input.executionTarget.providerKey !== "kubernetes" ||
    input.executionTarget.environmentId !== input.environmentId ||
    !input.executionTarget.leaseId
  )
    return refuse();
  const run = await deps.loadRun();
  if (
    !run ||
    run.id !== input.runId ||
    run.companyId !== input.companyId ||
    run.agentId !== input.agentId ||
    run.status !== "running"
  )
    return refuse();
  const lease = await deps.loadLease();
  const leaseMatches = (candidate: typeof lease) =>
    Boolean(
      candidate &&
      candidate.id === input.executionTarget?.leaseId &&
      candidate.companyId === input.companyId &&
      candidate.environmentId === input.environmentId &&
      candidate.heartbeatRunId === input.runId &&
      candidate.status === "active" &&
      candidate.provider === "kubernetes" &&
      candidate.providerLeaseId &&
      !candidate.releasedAt &&
      record(candidate.metadata).agentId === input.agentId &&
      record(candidate.metadata).onecliBootstrapPolicy ===
        "run-bindings-only-v1",
    );
  if (!leaseMatches(lease)) return refuse();
  const verifiedProviderLeaseId = lease!.providerLeaseId;
  const assignment = await deps.loadAssignment();
  if (
    !assignment ||
    assignment.companyId !== input.companyId ||
    assignment.targetType !== "agent" ||
    assignment.targetId !== input.agentId ||
    assignment.configPath !== ONECLI_IDENTITY_PATH ||
    !assignment.required ||
    assignment.versionSelector !== "latest"
  )
    return refuse();
  const secret = assignment.secret;
  if (
    secret.companyId !== input.companyId ||
    secret.scope !== "company" ||
    secret.provider !== "local_encrypted" ||
    secret.status !== "active" ||
    secret.deletedAt
  )
    return refuse();
  const verifiedVersion = secret.latestVersion;
  if (!Number.isSafeInteger(verifiedVersion) || verifiedVersion < 1)
    return refuse();
  const identity = parseOnecliIdentity(secret.providerMetadata);
  if (
    identity.companyId !== input.companyId ||
    identity.agentId !== input.agentId ||
    identity.environmentId !== input.environmentId
  )
    return refuse();
  let base: URL;
  try {
    base = new URL(input.trustedApiBase);
  } catch {
    return refuse();
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.pathname !== "/" &&
      base.pathname !== "/v1" &&
      base.pathname !== "/v1/")
  )
    return refuse();
  const endpoint = new URL("/v1/agent-identity", base);
  let token: string;
  try {
    token = await deps.resolveSecret(assignment.secretId, verifiedVersion);
  } catch {
    return refuse();
  }
  deps.registerForRedaction(token);
  if (!/^aoc_[A-Za-z0-9_-]+$/.test(token)) return refuse();
  try {
    const response = await deps.fetch(endpoint, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return refuse();
    // Endpoint is metadata-only; bound response size before parsing.
    const reader = response.body?.getReader();
    if (!reader) return refuse();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          return refuse();
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const keys = ["id", "identifier", "projectId", "organizationId"] as const;
    if (
      Object.keys(value).length !== keys.length ||
      keys.some((key) => value[key] !== identity[key])
    )
      return refuse();
  } catch {
    return refuse();
  }
  // Owner revocation/reassignment or run cancellation during HTTP verification must
  // not turn a stale pre-read into a successful dispatch.
  const currentRun = await deps.loadRun();
  const currentLease = await deps.loadLease();
  if (
    !leaseMatches(currentLease) ||
    currentLease!.providerLeaseId !== verifiedProviderLeaseId
  )
    return refuse();
  const current = await deps.loadAssignment();
  if (
    !currentRun ||
    currentRun.id !== input.runId ||
    currentRun.companyId !== input.companyId ||
    currentRun.agentId !== input.agentId ||
    currentRun.status !== "running" ||
    !current ||
    current.secretId !== assignment.secretId ||
    current.secret.latestVersion !== verifiedVersion ||
    current.companyId !== input.companyId ||
    current.targetType !== "agent" ||
    current.targetId !== input.agentId ||
    current.configPath !== ONECLI_IDENTITY_PATH ||
    !current.required ||
    current.versionSelector !== "latest" ||
    current.secret.companyId !== input.companyId ||
    current.secret.provider !== "local_encrypted" ||
    current.secret.scope !== "company" ||
    current.secret.status !== "active" ||
    current.secret.deletedAt
  )
    return refuse();
  const currentIdentity = parseOnecliIdentity(current.secret.providerMetadata);
  if (fields.some((key) => currentIdentity[key] !== identity[key]))
    return refuse();
  return {
    env: { ONECLI_AGENT_TOKEN: token, ONECLI_API_HOST: base.origin },
    secretKeys: ["ONECLI_AGENT_TOKEN"],
  };
}

/** Same trusted projection seam for initial resolution and realized-worker credentials. */
export function applyTrustedEnvProjection(
  config: Record<string, unknown>,
  projection: Record<string, string>,
  secretKeys: Set<string>,
  trustedEnvSecretKeys: string[],
): void {
  config.env = { ...record(config.env), ...projection };
  for (const key of trustedEnvSecretKeys) secretKeys.add(key);
}

/** Called only after native workspace realization; never from a config/probe resolver. */
export async function projectManagedOnecliToRealizedWorker(
  input: ManagedOnecliProjectionInput,
  deps: ManagedOnecliProjectionDependencies,
  config: Record<string, unknown>,
  secretKeys: Set<string>,
): Promise<void> {
  const projection = await resolveManagedOnecliProjection(input, deps);
  // Verification above proves this is the actual native Kubernetes target.
  const target = input.executionTarget!;
  config.env = scrubOnecliEnv(config.env);
  applyTrustedEnvProjection(
    config,
    projection.env,
    secretKeys,
    projection.secretKeys,
  );
  Object.defineProperty(target, "trustedRuntimeEnvKeys", {
    value: Object.freeze(Object.keys(record(config.env))),
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

/** Only the control-plane process selects this policy; agent settings are not inputs. */
export function managedOnecliBootstrapHint(environmentId: string): {
  onecliBootstrapPolicy?: "run-bindings-only-v1";
} {
  const configured = process.env.PAPERCLIP_ONECLI_MANAGED_ENVIRONMENT_ID;
  return configured && configured === environmentId
    ? { onecliBootstrapPolicy: "run-bindings-only-v1" }
    : {};
}

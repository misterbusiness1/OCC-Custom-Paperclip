/**
 * SandboxOrchestrator implementation backed by the kubernetes-sigs/agent-sandbox
 * Sandbox CRD (agents.x-k8s.io/v1beta1).
 *
 * The Sandbox CR creates a long-lived pod that paperclip-server can exec into
 * for multi-command adapter-install workflows — the key architectural win over
 * the batch/v1 Job backend.
 *
 * Key semantic differences from jobOrchestrator:
 * - claim() creates a Sandbox CR via CustomObjectsApi instead of a batch Job
 * - getStatus() maps current-generation Ready conditions to SandboxStatus
 * - findPod() verifies the controller owner UID on candidate pods
 * - waitForCompletion() means "wait until pod is Ready to exec" NOT "wait until
 *   workload finishes". The Sandbox pod runs sleep infinity; execution completion
 *   is tracked by the individual execInPod() calls.
 * - release() deletes the Sandbox CR with Foreground propagation (controller
 *   tears down the underlying pod).
 *
 * NOTE: streamLogs() is provided for interface conformance but is limited —
 * the sleep-infinity pod has no meaningful stdout. Callers in execute mode
 * should use execInPod() and capture its stdout/stderr directly.
 */

import type { KubeClients } from "./kube-client.js";
import type {
  SandboxOrchestrator,
  SandboxStatus,
} from "./sandbox-orchestrator.js";

import {
  SANDBOX_GROUP,
  SANDBOX_VERSION,
  SANDBOX_PLURAL,
  SANDBOX_API_VERSION,
} from "./sandbox-api.js";

export class SandboxCrTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(
      `Sandbox ${namespace}/${name} did not reach Ready phase within ${timeoutMs}ms`,
    );
    this.name = "SandboxCrTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SandboxResource = {
  metadata?: {
    uid?: string;
    name?: string;
    namespace?: string;
    generation?: number;
    deletionTimestamp?: string;
  };
  spec?: { operatingMode?: string };
  status?: {
    selector?: string;
    conditions?: Array<{
      type?: string;
      status?: string;
      observedGeneration?: number;
      reason?: string;
      message?: string;
    }>;
  };
};

/** The beta API exposes conditions, never status.phase or status.podName. */
function mapSandboxStatus(cr: SandboxResource): SandboxStatus {
  const pending: SandboxStatus = {
    phase: "Pending",
    complete: false,
    active: 0,
    succeeded: 0,
    failed: 0,
  };
  const fail = (reason: string, message?: string): SandboxStatus => ({
    ...pending,
    phase: "Failed",
    failed: 1,
    reason,
    message,
  });
  if (cr.metadata?.deletionTimestamp) return fail("Terminating");
  if (cr.spec?.operatingMode === "Suspended") return fail("SandboxSuspended");
  const generation = cr.metadata?.generation;
  if (!Number.isSafeInteger(generation) || generation! < 1) return pending;
  const conditions = Array.isArray(cr.status?.conditions)
    ? cr.status.conditions
    : [];
  const ready = conditions.filter((c) => c?.type === "Ready");
  if (ready.length !== 1 || ready[0].observedGeneration !== generation)
    return pending;
  const condition = ready[0];
  const finished = conditions.find(
    (c) =>
      c?.type === "Finished" &&
      c.status === "True" &&
      c.observedGeneration === generation,
  );
  if (finished) return fail(finished.reason ?? "Finished", finished.message);
  if (
    condition.status === "False" &&
    [
      "InvalidConfiguration",
      "MultiplePods",
      "SandboxExpired",
      "SandboxSuspended",
      "PodFailed",
      "PodSucceeded",
    ].includes(condition.reason ?? "")
  ) {
    return fail(condition.reason!, condition.message);
  }
  if (condition.status === "True")
    return { ...pending, phase: "Running", active: 1 };
  return { ...pending, reason: condition.reason, message: condition.message };
}

async function readSandbox(
  clients: KubeClients,
  namespace: string,
  name: string,
  expectedUid?: string,
): Promise<SandboxResource> {
  const cr = (await clients.custom.getNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
  })) as SandboxResource;
  if (
    !cr.metadata?.uid ||
    (expectedUid !== undefined && cr.metadata.uid !== expectedUid)
  )
    throw new Error("Sandbox UID does not match the lease");
  if (
    (cr.metadata.namespace !== undefined &&
      cr.metadata.namespace !== namespace) ||
    (cr.metadata.name !== undefined && cr.metadata.name !== name)
  )
    throw new Error("Sandbox identity does not match the lease");
  return cr;
}

export async function createSandboxCr(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.custom.createNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    body: manifest,
  });
  const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
  if (!uid) throw new Error("Sandbox CR created without a UID");
  return { uid };
}

export async function getSandboxCrStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
  expectedUid?: string,
): Promise<SandboxStatus> {
  return mapSandboxStatus(
    await readSandbox(clients, namespace, name, expectedUid),
  );
}

type SandboxPod = {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    deletionTimestamp?: string;
    ownerReferences?: Array<{
      uid?: string;
      name?: string;
      apiVersion?: string;
      kind?: string;
      controller?: boolean;
    }>;
  };
  status?: {
    phase?: string;
    podIPs?: Array<{ ip?: string }>;
    conditions?: Array<{ type?: string; status?: string }>;
  };
};

/** A selector or exact name only finds candidates; controller UID proves ownership. */
export async function findPodForSandbox(
  clients: KubeClients,
  namespace: string,
  name: string,
  expectedUid?: string,
): Promise<string | null> {
  const cr = await readSandbox(clients, namespace, name, expectedUid);
  const state = mapSandboxStatus(cr);
  if (state.phase === "Failed")
    throw new Error(`Sandbox cannot execute: ${state.reason}`);
  const candidates: SandboxPod[] = [];
  try {
    candidates.push(
      (await clients.core.readNamespacedPod({ namespace, name })) as SandboxPod,
    );
  } catch (err) {
    const code =
      (err as { code?: number; statusCode?: number }).code ??
      (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
  }
  if (
    typeof cr.status?.selector === "string" &&
    cr.status.selector.length > 0
  ) {
    const listed = await clients.core.listNamespacedPod({
      namespace,
      labelSelector: cr.status.selector,
    });
    candidates.push(...((listed as { items?: SandboxPod[] }).items ?? []));
  }
  const unique = new Map<string, SandboxPod>();
  for (const pod of candidates) {
    if (
      !pod?.metadata?.name ||
      pod.metadata.namespace !== namespace ||
      !pod.metadata.uid
    )
      continue;
    const owners =
      pod.metadata.ownerReferences?.filter((ref) => ref?.controller === true) ??
      [];
    if (
      owners.length !== 1 ||
      owners[0].uid !== cr.metadata!.uid ||
      owners[0].name !== name ||
      owners[0].apiVersion !== SANDBOX_API_VERSION ||
      owners[0].kind !== "Sandbox"
    )
      continue;
    unique.set(pod.metadata.uid, pod);
  }
  if (unique.size > 1)
    throw new Error(
      "Multiple controller-owned Sandbox pods; refusing to choose",
    );
  if (candidates.length > 0 && unique.size === 0)
    throw new Error("Sandbox has no controller-owned pod");
  const pod = [...unique.values()][0];
  if (!pod || state.phase !== "Running") return null;
  if (
    pod.metadata!.deletionTimestamp ||
    pod.status?.phase !== "Running" ||
    !pod.status.podIPs?.some(
      (ip) => typeof ip.ip === "string" && ip.ip.length > 0,
    ) ||
    !pod.status.conditions?.some(
      (c) => c?.type === "Ready" && c.status === "True",
    )
  )
    return null;
  return pod.metadata!.name!;
}

export async function streamSandboxLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  // V1 limitation: readNamespacedPodLog returns combined stdout. The
  // sleep-infinity pod will have minimal output; this is provided for interface
  // conformance. For actual command output, use execInPod() directly.
  const result = await clients.core.readNamespacedPodLog({
    namespace,
    name: podName,
  });
  const text = (result as string) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteSandboxCr(
  clients: KubeClients,
  namespace: string,
  name: string,
  expectedUid?: string,
): Promise<void> {
  const cr = await readSandbox(clients, namespace, name, expectedUid);
  await clients.custom.deleteNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
    propagationPolicy: "Foreground",
    body: { preconditions: { uid: cr.metadata!.uid } },
  });
}

/** Ready is current observed state, not a cached declaration or phase fallback. */
export async function waitForSandboxReady(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number; expectedUid?: string } = {
    timeoutMs: 120_000,
    pollMs: 2000,
  },
): Promise<SandboxStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const cr = await readSandbox(clients, namespace, name, opts.expectedUid);
    const state = mapSandboxStatus(cr);
    if (state.phase === "Failed")
      throw new Error(
        `Sandbox ${namespace}/${name} cannot reach Ready: ${state.reason} — ${state.message ?? ""}`,
      );
    if (state.phase === "Running") {
      if (await findPodForSandbox(clients, namespace, name, cr.metadata!.uid))
        return state;
      throw new Error(
        "Sandbox Ready condition has no current ready controller-owned pod",
      );
    }
    await sleep(
      Math.min(opts.pollMs ?? 2000, Math.max(0, deadline - Date.now())),
    );
  }
  throw new SandboxCrTimeoutError(namespace, name, opts.timeoutMs);
}

/**
 * Sandbox CR-backed conformance to SandboxOrchestrator.
 *
 * waitForCompletion semantics change: for this backend, "completion" means
 * "pod is up and Ready to exec into" — NOT "workload finished". The actual
 * command execution and its completion is handled by execInPod().
 */
export const sandboxCrOrchestrator: SandboxOrchestrator = {
  claim: createSandboxCr,
  getStatus: getSandboxCrStatus,
  findPod: findPodForSandbox,
  streamLogs: streamSandboxLogs,
  release: deleteSandboxCr,
  waitForCompletion: waitForSandboxReady,
};

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  clients: vi.fn(() => ({})),
  namespace: vi.fn(async () => {}),
  secret: vi.fn(async () => {}),
  claim: vi.fn(async () => ({ uid: "owned-uid" })),
  pod: vi.fn(async () => "owned-pod"),
  network: vi.fn(async () => "owned-network"),
}));
vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: calls.clients,
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({
  ensureTenant: calls.namespace,
}));
vi.mock("../../src/secret-manager.js", () => ({
  createPerRunSecret: calls.secret,
}));
vi.mock("../../src/job-orchestrator.js", () => ({
  jobOrchestrator: { claim: calls.claim, findPod: calls.pod },
  JobTimeoutError: class extends Error {},
}));
vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  sandboxCrOrchestrator: { claim: calls.claim, findPod: calls.pod },
  SandboxCrTimeoutError: class extends Error {},
}));
vi.mock("../../src/scoped-network-egress.js", async (original) => ({
  ...(await original<typeof import("../../src/scoped-network-egress.js")>()),
  createScopedNetworkEgressPolicyOrReleaseWorkload: calls.network,
}));
import plugin from "../../src/plugin.js";
import {
  buildLeaseAdapterEnv,
  type AdapterDefaults,
} from "../../src/adapter-defaults.js";

const defaults: AdapterDefaults = {
  runtimeImage: "ghcr.io/paperclipai/agent-runtime-claude:v1",
  envKeys: [],
  allowFqdns: [],
  probeCommand: [],
};
const config = (
  defaultEnv: Record<string, string> = {},
  envKeys: string[] = [],
) => ({
  inCluster: true,
  backend: "job",
  adapters: [{ ...defaults, adapterType: "claude_local", defaultEnv, envKeys }],
});
const params = {
  driverKey: "kubernetes",
  companyId: "company",
  environmentId: "environment",
  runId: "run",
  adapterType: "claude_local",
  onecliBootstrapPolicy: "run-bindings-only-v1" as const,
};
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());
describe("native managed Kubernetes bootstrap", () => {
  for (const key of [
    "ONECLI_API_KEY",
    "ONECLI_AGENT_TOKEN",
    "ONECLI_AGENT",
    "OPERATOR_PRIVATE_TOKEN",
    "CUSTOM_MODEL_ROUTE",
  ]) {
    it(`rejects defaultEnv ${key} before any namespace, workload or secret operation`, async () => {
      await expect(
        plugin.definition.onEnvironmentAcquireLease!({
          ...params,
          config: config({ [key]: "synthetic-parent" }),
        }),
      ).rejects.toThrow("empty host/default adapter env");
      expect(calls.clients).not.toHaveBeenCalled();
      expect(calls.namespace).not.toHaveBeenCalled();
      expect(calls.claim).not.toHaveBeenCalled();
      expect(calls.secret).not.toHaveBeenCalled();
    });
  }
  it("rejects envKeys inherited credentials before any Kubernetes operation", async () => {
    vi.stubEnv("ONECLI_API_KEY", "synthetic-parent-admin");
    await expect(
      plugin.definition.onEnvironmentAcquireLease!({
        ...params,
        config: config({}, ["ONECLI_API_KEY"]),
      }),
    ).rejects.toThrow("empty host/default adapter env");
    expect(calls.clients).not.toHaveBeenCalled();
    expect(calls.namespace).not.toHaveBeenCalled();
    expect(calls.claim).not.toHaveBeenCalled();
    expect(calls.secret).not.toHaveBeenCalled();
  });
  it("creates only native per-run bootstrap/network values and records the managed policy", async () => {
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      ...params,
      config: config(),
    });
    expect(lease.metadata).toHaveProperty(
      "onecliBootstrapPolicy",
      "run-bindings-only-v1",
    );
    expect(calls.secret).toHaveBeenCalledOnce();
    const passed = calls.secret.mock.calls[0] as unknown as [
      unknown,
      { bootstrapToken: string; adapterEnv: Record<string, string> },
    ];
    expect(passed[1].bootstrapToken.length).toBeGreaterThan(0);
    expect(Object.keys(passed[1].adapterEnv).sort()).toEqual([
      "PAPERCLIP_NETWORK_EGRESS_ALLOW_CIDRS",
      "PAPERCLIP_NETWORK_EGRESS_ALLOW_FQDNS",
      "PAPERCLIP_NETWORK_EGRESS_GRANT_PATH",
      "PAPERCLIP_NETWORK_EGRESS_POLICY",
    ]);
  });
  it("preserves ordinary nonmanaged bootstrap semantics", () => {
    expect(
      buildLeaseAdapterEnv(
        {
          ...defaults,
          envKeys: ["OPENAI_API_KEY"],
          defaultEnv: { ROUTE: "original" },
        },
        undefined,
        { OPENAI_API_KEY: "synthetic-existing" },
      ),
    ).toEqual({ ROUTE: "original", OPENAI_API_KEY: "synthetic-existing" });
  });
  it("refuses an unqualified reusable worker before even constructing a Kubernetes client", async () => {
    await expect(
      plugin.definition.onEnvironmentResumeLease!({
        driverKey: "kubernetes",
        companyId: "company",
        environmentId: "environment",
        config: config(),
        providerLeaseId: "legacy",
        onecliBootstrapPolicy: "run-bindings-only-v1",
        leaseMetadata: {},
      }),
    ).rejects.toThrow("unqualified bootstrap lease");
    expect(calls.clients).not.toHaveBeenCalled();
    expect(calls.secret).not.toHaveBeenCalled();
  });
});

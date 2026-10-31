import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Run onEnvironmentAcquireLease against mocked cluster-facing modules so the
// adapter resolution (registry lookup, image, labels, egress, env) can be
// asserted without a real cluster.
const h = vi.hoisted(() => ({
  claim: vi.fn(),
  findPod: vi.fn(),
  ensureTenant: vi.fn(),
  createPerRunSecret: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: h.ensureTenant }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: h.createPerRunSecret }));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sandbox-cr-orchestrator.js")>()),
  sandboxCrOrchestrator: { claim: h.claim, findPod: h.findPod },
}));

import plugin from "../../src/plugin.js";

const CURSOR_ENTRY = {
  adapterType: "cursor",
  runtimeImage: "registry.example/cursor:v1",
  envKeys: ["CURSOR_API_KEY"],
  allowFqdns: ["api2.cursor.sh"],
};

function acquire(config: Record<string, unknown>, adapterType?: string) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    runId: "run-1",
    config: { inCluster: true, egressMode: "cilium", ...config },
    ...(adapterType ? { adapterType } : {}),
  } as Parameters<NonNullable<typeof plugin.definition.onEnvironmentAcquireLease>>[0]);
}

function claimedManifest(): {
  metadata: { labels: Record<string, string> };
  spec: { podTemplate: { metadata: { labels: Record<string, string> }; spec: { containers: { image: string }[] } } };
} {
  return h.claim.mock.calls[0]![2];
}

beforeEach(() => {
  h.claim.mockReset().mockResolvedValue({ uid: "uid-1" });
  h.findPod.mockReset().mockResolvedValue("pod-1");
  h.ensureTenant.mockReset().mockResolvedValue(undefined);
  h.createPerRunSecret.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("CURSOR_API_KEY", "cur-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("onEnvironmentAcquireLease adapter resolution (cursor)", () => {
  it("resolves a legacy cursor_local environment against a registry entry keyed \"cursor\"", async () => {
    const lease = await acquire({ adapterType: "cursor_local", adapters: [CURSOR_ENTRY] });

    expect(lease.providerLeaseId).toMatch(/^pc-/);
    const manifest = claimedManifest();
    expect(manifest.metadata.labels["paperclip.io/adapter"]).toBe("cursor");
    expect(manifest.spec.podTemplate.metadata.labels["paperclip.io/adapter"]).toBe("cursor");
    expect(manifest.spec.podTemplate.spec.containers[0]!.image).toBe("registry.example/cursor:v1");
    expect(h.ensureTenant.mock.calls[0]![1].egressAllowFqdns).toEqual(["api2.cursor.sh"]);
    expect(h.createPerRunSecret.mock.calls[0]![1].adapterEnv).toEqual({ CURSOR_API_KEY: "cur-secret" });
  });

  it("normalises a per-run cursor_local hint before the registry lookup and label", async () => {
    await acquire({ adapters: [CURSOR_ENTRY] }, "cursor_local");

    expect(claimedManifest().metadata.labels["paperclip.io/adapter"]).toBe("cursor");
    expect(claimedManifest().spec.podTemplate.spec.containers[0]!.image).toBe(
      "registry.example/cursor:v1",
    );
  });

  it("fails fast with an actionable error for cursor without a registry entry (no pod is created)", async () => {
    await expect(acquire({ adapterType: "cursor" })).rejects.toThrow(
      /Cursor has no built-in Kubernetes runtime image; add an adapters registry entry for "cursor"/,
    );
    await expect(acquire({}, "cursor")).rejects.toThrow(/no built-in Kubernetes runtime image/);
    expect(h.claim).not.toHaveBeenCalled();
  });
});

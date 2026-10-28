import { describe, it, expect, vi } from "vitest";
import {
  getSandboxCrStatus,
  waitForSandboxReady,
  findPodForSandbox,
  deleteSandboxCr,
} from "../../src/sandbox-cr-orchestrator.js";
const cr = (observedGeneration = 2) => ({
  apiVersion: "agents.x-k8s.io/v1beta1",
  kind: "Sandbox",
  metadata: { uid: "uid-1", name: "lease", namespace: "ns", generation: 2 },
  status: {
    selector: "agents.x-k8s.io/sandbox-name-hash=abc",
    conditions: [
      {
        type: "Ready",
        status: "True",
        observedGeneration,
        reason: "DependenciesReady",
      },
    ],
  },
});
const pod = (uid = "uid-1") => ({
  metadata: {
    name: "lease",
    namespace: "ns",
    uid: "pod-1",
    ownerReferences: [
      {
        apiVersion: "agents.x-k8s.io/v1beta1",
        kind: "Sandbox",
        name: "lease",
        uid,
        controller: true,
      },
    ],
  },
  status: {
    phase: "Running",
    podIPs: [{ ip: "10.1.1.1" }],
    conditions: [{ type: "Ready", status: "True" }],
  },
});
function clients(resource = cr(), child = pod()) {
  return {
    custom: {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(resource),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
    core: {
      readNamespacedPod: vi.fn().mockResolvedValue(child),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [child] }),
    },
  };
}
describe("native v1.0.8 beta boundary", () => {
  it("maps the real condition-only Ready shape and uses beta API", async () => {
    const c = clients();
    const status = await getSandboxCrStatus(c as never, "ns", "lease");
    expect(status).toMatchObject({
      phase: "Running",
      active: 1,
      complete: false,
    });
    expect(c.custom.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ version: "v1beta1" }),
    );
  });
  it("does not admit stale observedGeneration", async () => {
    const c = clients(cr(1));
    expect(await getSandboxCrStatus(c as never, "ns", "lease")).toMatchObject({
      phase: "Pending",
      active: 0,
    });
    await expect(
      waitForSandboxReady(c as never, "ns", "lease", {
        timeoutMs: 4,
        pollMs: 1,
      }),
    ).rejects.toThrow(/Ready/);
  });
  it("rejects a same-name foreign Pod despite a Ready CR", async () => {
    await expect(
      findPodForSandbox(clients(cr(), pod("foreign")) as never, "ns", "lease"),
    ).rejects.toThrow(/owned/);
  });
  it("resolves only the one controller-owned ready Pod", async () => {
    expect(await findPodForSandbox(clients() as never, "ns", "lease")).toBe(
      "lease",
    );
  });
  it("refuses deletion of a replacement UID", async () => {
    const c = clients();
    await expect(
      deleteSandboxCr(c as never, "ns", "lease", "old-uid"),
    ).rejects.toThrow(/UID/);
    expect(c.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from "vitest";
import {
  createSandboxCr,
  deleteSandboxCr,
  getSandboxCrStatus,
  findPodForSandbox,
  SandboxCrTimeoutError,
  waitForSandboxReady,
} from "../../src/sandbox-cr-orchestrator.js";
import { betaSandbox, betaPod } from "./sandbox-beta-fixtures.js";
function clients(
  resource: unknown = betaSandbox(),
  pods: unknown[] = [betaPod()],
) {
  return {
    custom: {
      createNamespacedCustomObject: vi
        .fn()
        .mockResolvedValue({ metadata: { uid: "uid-1" } }),
      getNamespacedCustomObject: vi.fn().mockResolvedValue(resource),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
    core: {
      readNamespacedPod: vi.fn().mockImplementation(async () => {
        if (!pods.length) throw { code: 404 };
        return pods[0];
      }),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: pods }),
      readNamespacedPodLog: vi.fn(),
    },
  };
}
describe("native beta Sandbox CRUD", () => {
  it("creates only beta resources and requires a UID", async () => {
    const c = clients();
    const body = { apiVersion: "agents.x-k8s.io/v1beta1", kind: "Sandbox" };
    expect(await createSandboxCr(c as never, "ns", body)).toEqual({
      uid: "uid-1",
    });
    expect(c.custom.createNamespacedCustomObject).toHaveBeenCalledWith({
      group: "agents.x-k8s.io",
      version: "v1beta1",
      namespace: "ns",
      plural: "sandboxes",
      body,
    });
    c.custom.createNamespacedCustomObject.mockResolvedValue({
      metadata: {},
    } as never);
    await expect(createSandboxCr(c as never, "ns", body)).rejects.toThrow(
      /UID/,
    );
  });
  it("deletes with foreground GC and immutable UID precondition", async () => {
    const c = clients();
    await deleteSandboxCr(c as never, "ns", "pc-abc", "uid-1");
    expect(c.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith({
      group: "agents.x-k8s.io",
      version: "v1beta1",
      namespace: "ns",
      plural: "sandboxes",
      name: "pc-abc",
      propagationPolicy: "Foreground",
      body: { preconditions: { uid: "uid-1" } },
    });
  });
});
describe("native beta conditions", () => {
  it("maps Ready=True at current generation to active Running", async () => {
    expect(
      await getSandboxCrStatus(clients() as never, "ns", "pc-abc"),
    ).toEqual({
      phase: "Running",
      active: 1,
      complete: false,
      succeeded: 0,
      failed: 0,
    });
  });
  it.each(["False", "Unknown"])("keeps Ready=%s pending", async (status) => {
    const cr = betaSandbox();
    cr.status.conditions[0].status = status;
    expect(
      await getSandboxCrStatus(clients(cr) as never, "ns", "pc-abc"),
    ).toMatchObject({ phase: "Pending", active: 0 });
  });
  it.each([0, 2, undefined])(
    "rejects stale/missing observedGeneration %s",
    async (observed) => {
      const cr = betaSandbox();
      cr.status.conditions[0].observedGeneration = observed as never;
      expect(
        await getSandboxCrStatus(clients(cr) as never, "ns", "pc-abc"),
      ).toMatchObject({ phase: "Pending", active: 0 });
    },
  );
  it("does not use obsolete phase or duplicate Ready conditions", async () => {
    const cr = betaSandbox();
    cr.status.conditions.push(cr.status.conditions[0]);
    expect(
      await getSandboxCrStatus(clients(cr) as never, "ns", "pc-abc"),
    ).toMatchObject({ phase: "Pending" });
    expect(
      await getSandboxCrStatus(
        clients({ metadata: cr.metadata, status: { phase: "Ready" } }) as never,
        "ns",
        "pc-abc",
      ),
    ).toMatchObject({ phase: "Pending" });
  });
  it.each([
    "InvalidConfiguration",
    "MultiplePods",
    "SandboxExpired",
    "SandboxSuspended",
    "PodFailed",
    "PodSucceeded",
  ])("refuses terminal reason %s", async (reason) => {
    const cr = betaSandbox(false);
    cr.status.conditions[0].reason = reason;
    expect(
      await getSandboxCrStatus(clients(cr) as never, "ns", "pc-abc"),
    ).toMatchObject({ phase: "Failed", reason });
  });
  it("does not turn transient reconciliation failures into terminal errors", async () => {
    const cr = betaSandbox(false);
    cr.status.conditions[0].reason = "ReconcilerError";
    expect(
      await getSandboxCrStatus(clients(cr) as never, "ns", "pc-abc"),
    ).toMatchObject({ phase: "Pending", reason: "ReconcilerError" });
  });
  it("rejects deleting, suspended or Finished despite Ready=True", async () => {
    for (const cr of [
      {
        ...betaSandbox(),
        metadata: {
          ...betaSandbox().metadata,
          deletionTimestamp: "2026-10-28T00:00:00Z",
        },
      },
      { ...betaSandbox(), spec: { operatingMode: "Suspended" } },
      {
        ...betaSandbox(),
        status: {
          conditions: [
            ...betaSandbox().status.conditions,
            {
              type: "Finished",
              status: "True",
              observedGeneration: 1,
              reason: "PodFailed",
            },
          ],
        },
      },
    ]) {
      expect(
        await getSandboxCrStatus(clients(cr) as never, "ns", "pc-abc"),
      ).toMatchObject({ phase: "Failed", active: 0 });
    }
  });
});
describe("UID-controlled pod discovery", () => {
  it("resolves canonical name and selector candidates only by owner UID", async () => {
    const c = clients();
    expect(await findPodForSandbox(c as never, "ns", "pc-abc", "uid-1")).toBe(
      "pc-abc",
    );
    expect(c.core.listNamespacedPod).toHaveBeenCalledWith({
      namespace: "ns",
      labelSelector: betaSandbox().status.selector,
    });
  });
  it("can resolve an owned renamed candidate through the controller selector", async () => {
    const c = clients(betaSandbox(), [
      betaPod("ns", "pc-abc", "uid-1", "warm-pod"),
    ]);
    c.core.readNamespacedPod.mockRejectedValue({ code: 404 });
    expect(await findPodForSandbox(c as never, "ns", "pc-abc", "uid-1")).toBe(
      "warm-pod",
    );
  });
  it.each(["foreign", "unowned", "namespace", "controller", "kind"])(
    "rejects %s candidate",
    async (variant) => {
      const pod = betaPod();
      if (variant === "foreign")
        pod.metadata.ownerReferences[0].uid = "foreign";
      if (variant === "unowned") pod.metadata.ownerReferences = [];
      if (variant === "namespace") pod.metadata.namespace = "other";
      if (variant === "controller")
        pod.metadata.ownerReferences[0].controller = false;
      if (variant === "kind") pod.metadata.ownerReferences[0].kind = "Job";
      await expect(
        findPodForSandbox(
          clients(betaSandbox(), [pod]) as never,
          "ns",
          "pc-abc",
        ),
      ).rejects.toThrow(/owned/);
    },
  );
  it("refuses multiple owned pods instead of picking a running candidate", async () => {
    await expect(
      findPodForSandbox(
        clients(betaSandbox(), [
          betaPod(),
          betaPod("ns", "pc-abc", "uid-1", "second"),
        ]) as never,
        "ns",
        "pc-abc",
      ),
    ).rejects.toThrow(/Multiple/);
  });
  it("returns null without a current Ready Pod and preserves non-404 API errors", async () => {
    expect(
      await findPodForSandbox(
        clients(betaSandbox(), []) as never,
        "ns",
        "pc-abc",
      ),
    ).toBeNull();
    const pod = betaPod();
    pod.status.conditions[0].status = "False";
    expect(
      await findPodForSandbox(
        clients(betaSandbox(), [pod]) as never,
        "ns",
        "pc-abc",
      ),
    ).toBeNull();
    const c = clients();
    c.core.readNamespacedPod.mockRejectedValue({ code: 403 });
    await expect(
      findPodForSandbox(c as never, "ns", "pc-abc"),
    ).rejects.toMatchObject({ code: 403 });
  });
});
describe("beta readiness polling", () => {
  it("returns the same Running status as getStatus after verifying an owned ready Pod", async () => {
    const c = clients();
    expect(
      await waitForSandboxReady(c as never, "ns", "pc-abc", {
        timeoutMs: 100,
        pollMs: 1,
        expectedUid: "uid-1",
      }),
    ).toEqual(await getSandboxCrStatus(c as never, "ns", "pc-abc"));
  });
  it("times out boundedly when Ready never arrives", async () => {
    await expect(
      waitForSandboxReady(
        clients(betaSandbox(false)) as never,
        "ns",
        "pc-abc",
        { timeoutMs: 4, pollMs: 1 },
      ),
    ).rejects.toBeInstanceOf(SandboxCrTimeoutError);
  });
  it("fails fast on replacement UID", async () => {
    await expect(
      waitForSandboxReady(clients() as never, "ns", "pc-abc", {
        timeoutMs: 100,
        expectedUid: "old",
      }),
    ).rejects.toThrow(/UID/);
  });
});

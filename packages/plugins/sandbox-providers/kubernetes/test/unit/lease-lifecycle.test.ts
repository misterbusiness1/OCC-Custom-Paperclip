import { describe, it, expect, vi } from "vitest";
import {
  checkLeaseResumable,
  destroyLeaseResources,
  isKubeNotFoundError,
} from "../../src/lease-lifecycle.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1beta1";
const SANDBOX_PLURAL = "sandboxes";

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

import { betaSandbox, betaPod } from "./sandbox-beta-fixtures.js";

describe("isKubeNotFoundError", () => {
  it("matches code=404 and statusCode=404", () => {
    expect(isKubeNotFoundError({ code: 404 })).toBe(true);
    expect(isKubeNotFoundError({ statusCode: 404 })).toBe(true);
  });

  it("does not match other errors", () => {
    expect(isKubeNotFoundError({ code: 500 })).toBe(false);
    expect(isKubeNotFoundError(new Error("boom"))).toBe(false);
  });
});

describe("checkLeaseResumable (sandbox-cr backend)", () => {
  const input = {
    namespace: "ns",
    name: "pc-abc",
    backend: "sandbox-cr" as const,
    expectedUid: "uid-1",
    readyTimeoutMs: 8,
    pollMs: 1,
  };
  function clients(cr: unknown = betaSandbox(), pod: unknown = betaPod()) {
    return {
      custom: { getNamespacedCustomObject: vi.fn().mockResolvedValue(cr) },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue(pod),
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [pod] }),
      },
    };
  }
  it("resumes only the exact current UID with an owned ready pod", async () => {
    expect(await checkLeaseResumable(clients() as never, input)).toEqual({
      resumable: true,
      podName: "pc-abc",
      phase: "Running",
    });
  });
  it("expires an old lease with no recorded UID before any API call", async () => {
    const c = clients();
    expect(
      await checkLeaseResumable(c as never, {
        ...input,
        expectedUid: undefined,
      }),
    ).toMatchObject({ resumable: false });
    expect(c.custom.getNamespacedCustomObject).not.toHaveBeenCalled();
  });
  it("expires a deleted CR and rejects recreation under the same name", async () => {
    const c = clients();
    c.custom.getNamespacedCustomObject.mockRejectedValue(notFound());
    expect(await checkLeaseResumable(c as never, input)).toMatchObject({
      resumable: false,
      reason: "Sandbox CR no longer exists",
    });
    expect(
      await checkLeaseResumable(clients() as never, {
        ...input,
        expectedUid: "old",
      }),
    ).toMatchObject({ resumable: false });
  });
  it("expires terminal failure without waiting for the timeout", async () => {
    const cr = betaSandbox(false);
    cr.status.conditions[0].reason = "PodFailed";
    expect(
      await checkLeaseResumable(clients(cr) as never, input),
    ).toMatchObject({
      resumable: false,
      reason: expect.stringContaining("PodFailed"),
    });
  });
  it("times out boundedly when the current generation is not ready", async () => {
    expect(
      await checkLeaseResumable(clients(betaSandbox(false)) as never, input),
    ).toMatchObject({
      resumable: false,
      reason: expect.stringContaining("Ready"),
    });
  });
  it("expires missing or deleting Pods despite a Ready CR", async () => {
    const c = clients();
    c.core.readNamespacedPod.mockRejectedValue(notFound());
    c.core.listNamespacedPod.mockResolvedValue({ items: [] });
    expect(await checkLeaseResumable(c as never, input)).toMatchObject({
      resumable: false,
    });
    const pod = {
      ...betaPod(),
      metadata: {
        ...betaPod().metadata,
        deletionTimestamp: "2026-10-28T00:00:00Z",
      },
    };
    expect(
      await checkLeaseResumable(clients(betaSandbox(), pod) as never, input),
    ).toMatchObject({ resumable: false });
  });
  it("propagates unexpected Kubernetes API failures", async () => {
    const c = clients();
    c.core.readNamespacedPod.mockRejectedValue(
      Object.assign(new Error("forbidden"), { code: 403 }),
    );
    await expect(checkLeaseResumable(c as never, input)).rejects.toThrow(
      "forbidden",
    );
  });
});

describe("checkLeaseResumable (job backend)", () => {
  it("resumes a Running Job lease", async () => {
    const clients = {
      batch: {
        readNamespacedJobStatus: vi
          .fn()
          .mockResolvedValue({ status: { active: 1 } }),
      },
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({
          items: [
            { metadata: { name: "pc-job-pod" }, status: { phase: "Running" } },
          ],
        }),
      },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
    });
    expect(result).toEqual({
      resumable: true,
      podName: "pc-job-pod",
      phase: "Running",
    });
  });

  it("is not resumable when the Job is gone (404)", async () => {
    const clients = {
      batch: { readNamespacedJobStatus: vi.fn().mockRejectedValue(notFound()) },
      core: { listNamespacedPod: vi.fn() },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/no longer exists/);
  });

  it("is not resumable when the Job already finished (terminal phase)", async () => {
    const clients = {
      batch: {
        readNamespacedJobStatus: vi.fn().mockResolvedValue({
          status: {
            succeeded: 1,
            conditions: [{ type: "Complete", status: "True" }],
          },
        }),
      },
      core: { listNamespacedPod: vi.fn() },
    };
    const result = await checkLeaseResumable(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
    });
    expect(result.resumable).toBe(false);
    if (!result.resumable) expect(result.reason).toMatch(/Succeeded/);
  });
});

describe("destroyLeaseResources", () => {
  function makeClients() {
    return {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(betaSandbox()),
        deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      },
      batch: { deleteNamespacedJob: vi.fn().mockResolvedValue({}) },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
    };
  }

  it("UID-preconditions the Sandbox CR cascade without deleting cached child names", async () => {
    const clients = makeClients();
    await destroyLeaseResources(clients as never, {
      namespace: "ns",
      name: "pc-abc",
      backend: "sandbox-cr",
      expectedUid: "uid-1",
      podName: "pc-abc-pod",
      secretName: "pc-abc-env",
    });
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace: "ns",
      plural: SANDBOX_PLURAL,
      name: "pc-abc",
      propagationPolicy: "Foreground",
      body: { preconditions: { uid: "uid-1" } },
    });
    expect(clients.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedSecret).not.toHaveBeenCalled();
    expect(clients.batch.deleteNamespacedJob).not.toHaveBeenCalled();
  });

  it("deletes the Job instead of the Sandbox CR (job backend)", async () => {
    const clients = makeClients();
    await destroyLeaseResources(clients as never, {
      namespace: "ns",
      name: "pc-job",
      backend: "job",
      podName: null,
      secretName: "pc-job-env",
    });
    expect(clients.batch.deleteNamespacedJob).toHaveBeenCalledWith({
      namespace: "ns",
      name: "pc-job",
      propagationPolicy: "Foreground",
    });
    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(clients.core.deleteNamespacedSecret).toHaveBeenCalledWith({
      namespace: "ns",
      name: "pc-job-env",
    });
  });

  it("is idempotent: every 404 is treated as success", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: vi.fn() },
      core: {
        deleteNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
      },
    };
    await expect(
      destroyLeaseResources(clients as never, {
        namespace: "ns",
        name: "pc-abc",
        backend: "sandbox-cr",
        expectedUid: "uid-1",
        podName: "pc-abc-pod",
        secretName: "pc-abc-env",
      }),
    ).resolves.toBeUndefined();
    expect(clients.core.deleteNamespacedSecret).not.toHaveBeenCalled();
  });

  it("rethrows unexpected (non-404) delete errors", async () => {
    const clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockResolvedValue(betaSandbox()),
        deleteNamespacedCustomObject: vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("forbidden"), { code: 403 }),
          ),
      },
      batch: { deleteNamespacedJob: vi.fn() },
      core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() },
    };
    await expect(
      destroyLeaseResources(clients as never, {
        namespace: "ns",
        name: "pc-abc",
        backend: "sandbox-cr",
        expectedUid: "uid-1",
        podName: null,
        secretName: null,
      }),
    ).rejects.toThrow("forbidden");
  });
});

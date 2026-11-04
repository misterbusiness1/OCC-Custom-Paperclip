import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the kube-client module so the plugin handlers run against injected
// fake API clients instead of a real cluster. h.clients is swapped per test.
const h = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  exec: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));

vi.mock("../../src/pod-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/pod-exec.js")>()),
  execInPod: h.exec,
  execInPodStreaming: vi.fn(),
}));

import plugin from "../../src/plugin.js";
import { betaSandbox, betaPod } from "./sandbox-beta-fixtures.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function leaseMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    namespace: "paperclip-acme",
    workloadUid: "uid-1",
    jobName: "pc-abc",
    podName: "pc-abc-pod",
    secretName: "pc-abc-env",
    phase: "Pending",
    backend: "sandbox-cr",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: 404 });
}

function readySandboxCr(_podName: string): Record<string, unknown> {
  return betaSandbox(true, "paperclip-acme");
}

beforeEach(() => {
  h.clients = {};
  h.exec.mockReset().mockResolvedValue({
    exitCode: 0,
    stdout: "synthetic",
    stderr: "",
    timedOut: false,
  });
});

describe("onEnvironmentResumeLease", () => {
  it("is implemented (Daytona feature parity)", () => {
    expect(plugin.definition.onEnvironmentResumeLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  it("returns a valid lease handle for a live sandbox-cr lease", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi
          .fn()
          .mockResolvedValue(betaPod("paperclip-acme", "pc-abc")),
        listNamespacedPod: vi
          .fn()
          .mockResolvedValue({ items: [betaPod("paperclip-acme", "pc-abc")] }),
      },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBe("pc-abc");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        namespace: "paperclip-acme",
        jobName: "pc-abc",
        podName: "pc-abc",
        secretName: "pc-abc-env",
        phase: "Running",
        backend: "sandbox-cr",
        resumedLease: true,
        // sandbox-cr has a pod-exec channel, so native file sync stays enabled.
        nativeFileSyncUnsupported: false,
      }),
    );
  });

  it("flags a resumed job-backend lease as native-sync-unsupported so the server keeps the base64 fallback", async () => {
    h.clients = {
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

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({
        jobName: "pc-job",
        backend: "job",
        podName: "pc-job-pod",
      }),
    });

    expect(lease.providerLeaseId).toBe("pc-job");
    expect(lease.metadata).toEqual(
      expect.objectContaining({
        backend: "job",
        // The job backend has no exec channel; its native sync hook rejects, so
        // the lease must fall back to the byte-identical base64 transport.
        nativeFileSyncUnsupported: true,
      }),
    );
  });

  it("returns providerLeaseId null (expired) when the Sandbox CR is gone, so the caller falls back to acquireLease", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
      },
      core: { readNamespacedPod: vi.fn() },
    };

    const lease = await plugin.definition.onEnvironmentResumeLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(lease.providerLeaseId).toBeNull();
    expect(lease.metadata?.expired).toBe(true);
    expect(lease.metadata?.reason).toMatch(/no longer exists/);
  });

  it("returns providerLeaseId null when the backing pod is gone", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue(readySandboxCr("pc-abc-pod")),
      },
      core: {
        readNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      },
    };

    // A Ready CR whose pod never becomes observable is polled until the
    // bounded resume deadline, then reported non-resumable.
    vi.useFakeTimers();
    try {
      const pending = plugin.definition.onEnvironmentResumeLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      });
      await vi.advanceTimersByTimeAsync(31_000);
      const lease = await pending;

      expect(lease.providerLeaseId).toBeNull();
      expect(lease.metadata?.expired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("onEnvironmentDestroyLease", () => {
  it("UID-preconditions CR cascade and never deletes cached child names", async () => {
    const deleteCr = vi.fn().mockResolvedValue({});
    const deletePod = vi.fn().mockResolvedValue({});
    const deleteSecret = vi.fn().mockResolvedValue({});
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue(betaSandbox(true, "paperclip-acme")),
        deleteNamespacedCustomObject: deleteCr,
      },
      core: {
        deleteNamespacedPod: deletePod,
        deleteNamespacedSecret: deleteSecret,
      },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
      leaseMetadata: leaseMetadata(),
    });

    expect(deleteCr).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-abc" }),
    );
    expect(deletePod).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("is idempotent: resolves cleanly when every resource is already gone (404)", async () => {
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedCustomObject: vi.fn().mockRejectedValue(notFound()),
      },
      core: {
        deleteNamespacedPod: vi.fn().mockRejectedValue(notFound()),
        deleteNamespacedSecret: vi.fn().mockRejectedValue(notFound()),
      },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await expect(
      plugin.definition.onEnvironmentDestroyLease!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        providerLeaseId: "pc-abc",
        leaseMetadata: leaseMetadata(),
      }),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when providerLeaseId is null", async () => {
    const deleteCr = vi.fn();
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue(betaSandbox(true, "paperclip-acme")),
        deleteNamespacedCustomObject: deleteCr,
      },
      core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() },
      batch: { deleteNamespacedJob: vi.fn() },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: null,
      leaseMetadata: undefined,
    });

    expect(deleteCr).not.toHaveBeenCalled();
  });

  it("deletes the Job for job-backend leases", async () => {
    const deleteJob = vi.fn().mockResolvedValue({});
    const deleteCr = vi.fn();
    h.clients = {
      custom: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue(betaSandbox(true, "paperclip-acme")),
        deleteNamespacedCustomObject: deleteCr,
      },
      core: {
        deleteNamespacedPod: vi.fn().mockResolvedValue({}),
        deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      },
      batch: { deleteNamespacedJob: deleteJob },
    };

    await plugin.definition.onEnvironmentDestroyLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: { inCluster: true, backend: "job" },
      providerLeaseId: "pc-job",
      leaseMetadata: leaseMetadata({
        jobName: "pc-job",
        backend: "job",
        podName: "pc-job-pod",
        secretName: "pc-job-env",
      }),
    });

    expect(deleteJob).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "paperclip-acme", name: "pc-job" }),
    );
    expect(deleteCr).not.toHaveBeenCalled();
  });
});

describe("native lease execution revalidation", () => {
  function executionParams() {
    return {
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease: {
        providerLeaseId: "pc-abc",
        metadata: leaseMetadata({
          podName: "cached-foreign",
          remoteCwd: "/workspace",
        }),
      },
      command: "true",
      args: [],
      timeoutMs: 100,
    };
  }
  function runningClients() {
    return {
      custom: {
        getNamespacedCustomObject: vi
          .fn()
          .mockResolvedValue(betaSandbox(true, "paperclip-acme")),
      },
      core: {
        readNamespacedPod: vi.fn().mockResolvedValue(betaPod("paperclip-acme")),
        listNamespacedPod: vi
          .fn()
          .mockResolvedValue({ items: [betaPod("paperclip-acme")] }),
      },
    };
  }
  it("ignores cached Pod name and rechecks CR UID after a successful exec", async () => {
    const c = runningClients();
    h.clients = c;
    await plugin.definition.onEnvironmentExecute!(executionParams() as never);
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.exec.mock.calls[0].slice(1, 4)).toEqual([
      "paperclip-acme",
      "pc-abc",
      "agent",
    ]);
    c.custom.getNamespacedCustomObject.mockResolvedValue(
      betaSandbox(true, "paperclip-acme", "pc-abc", "replacement"),
    );
    await expect(
      plugin.definition.onEnvironmentExecute!(executionParams() as never),
    ).rejects.toThrow(/UID/);
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("refuses a foreign same-name Pod even after this lease succeeded earlier", async () => {
    const c = runningClients();
    h.clients = c;
    await plugin.definition.onEnvironmentExecute!(executionParams() as never);
    c.core.readNamespacedPod.mockResolvedValue(
      betaPod("paperclip-acme", "pc-abc", "foreign"),
    );
    c.core.listNamespacedPod.mockResolvedValue({
      items: [betaPod("paperclip-acme", "pc-abc", "foreign")],
    });
    await expect(
      plugin.definition.onEnvironmentExecute!(executionParams() as never),
    ).rejects.toThrow(/owned/);
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("does not reuse cached readiness after the CR generation changes", async () => {
    const c = runningClients();
    h.clients = c;
    await plugin.definition.onEnvironmentExecute!(executionParams() as never);
    const changed = betaSandbox(true, "paperclip-acme");
    changed.metadata.generation = 2;
    c.custom.getNamespacedCustomObject.mockResolvedValue(changed);
    const result = await plugin.definition.onEnvironmentExecute!({
      ...executionParams(),
      timeoutMs: 4,
    } as never);
    expect(result.timedOut).toBe(true);
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("rechecks readiness for native file sync instead of trusting cached metadata", async () => {
    const c = runningClients();
    h.clients = c;
    await plugin.definition.onEnvironmentExecute!(executionParams() as never);
    c.custom.getNamespacedCustomObject.mockResolvedValue(
      betaSandbox(true, "paperclip-acme", "pc-abc", "replacement"),
    );
    const params = { ...executionParams(), operations: [] };
    await expect(
      plugin.definition.onEnvironmentSyncIn!(params as never),
    ).rejects.toThrow(/UID/);
    await expect(
      plugin.definition.onEnvironmentSyncOut!(params as never),
    ).rejects.toThrow(/UID/);
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
});

describe("operator-confirmed legacy Sandbox cleanup", () => {
  const key = JSON.stringify(["paperclip-acme", "pc-abc"]);
  const cleanupConfig = { ...CONFIG, legacySandboxCleanupUids: { [key]: "uid-1" } };
  function clients() {
    const custom = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(betaSandbox(true, "paperclip-acme")),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    };
    h.clients = { custom, core: { deleteNamespacedPod: vi.fn(), deleteNamespacedSecret: vi.fn() } };
    return custom;
  }
  function params(config = cleanupConfig, metadata = leaseMetadata({ workloadUid: undefined })) {
    return { driverKey: "kubernetes", companyId: "acme", environmentId: "env-1", config,
      providerLeaseId: "pc-abc", leaseMetadata: metadata };
  }
  for (const operation of ["onEnvironmentReleaseLease", "onEnvironmentDestroyLease"] as const) {
    it(`${operation} accepts only the exact operator UID and retains foreground UID preconditions`, async () => {
      const c = clients();
      await plugin.definition[operation]!(params());
      expect(c.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({
        namespace: "paperclip-acme", name: "pc-abc", propagationPolicy: "Foreground",
        body: { preconditions: { uid: "uid-1" } },
      }));
      expect((h.clients.core as { deleteNamespacedPod: ReturnType<typeof vi.fn> }).deleteNamespacedPod).not.toHaveBeenCalled();
      expect((h.clients.core as { deleteNamespacedSecret: ReturnType<typeof vi.fn> }).deleteNamespacedSecret).not.toHaveBeenCalled();
    });
    it(`${operation} refuses absent and unmatched assertions without looking up a current UID`, async () => {
      const c = clients();
      for (const config of [CONFIG, { ...CONFIG, legacySandboxCleanupUids: { [JSON.stringify(["other", "pc-abc"])]: "uid-1" } }, { ...CONFIG, legacySandboxCleanupUids: { [JSON.stringify(["paperclip-acme", "other"])]: "uid-1" } }]) {
        await expect(plugin.definition[operation]!(params(config as typeof cleanupConfig))).rejects.toThrow("operator-confirmed UID");
      }
      expect(c.getNamespacedCustomObject).not.toHaveBeenCalled();
      expect(c.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    });
    it(`${operation} keeps persisted UID authoritative and refuses a recreated resource`, async () => {
      const c = clients();
      await expect(plugin.definition[operation]!(params(cleanupConfig, leaseMetadata({ workloadUid: "old-uid" })))).rejects.toThrow("UID does not match");
      expect(c.deleteNamespacedCustomObject).not.toHaveBeenCalled();
    });
    it(`${operation} propagates a UID precondition race without deleting cached children`, async () => {
      const c = clients();
      c.deleteNamespacedCustomObject.mockRejectedValue(Object.assign(new Error("UID precondition conflict"), { statusCode: 409 }));
      await expect(plugin.definition[operation]!(params())).rejects.toThrow("UID precondition conflict");
    });
  }
  it("does not grant resume or execution permission to a UID-less lease", async () => {
    const c = clients();
    const p = params();
    const lease = await plugin.definition.onEnvironmentResumeLease!(p);
    expect(lease.providerLeaseId).toBeNull();
    await expect(plugin.definition.onEnvironmentExecute!({ ...p,
      lease: { providerLeaseId: p.providerLeaseId, metadata: p.leaseMetadata }, command: "true", args: [], timeoutMs: 100,
    } as never)).rejects.toThrow("no verified workload UID");
    expect(c.getNamespacedCustomObject).not.toHaveBeenCalled();
    for (const operation of ["onEnvironmentSyncIn", "onEnvironmentSyncOut"] as const) {
      await expect(plugin.definition[operation]!({ ...p,
        lease: { providerLeaseId: p.providerLeaseId, metadata: { ...p.leaseMetadata, remoteCwd: "/workspace" } },
        operations: [], timeoutMs: 100,
      } as never)).rejects.toThrow("no verified workload UID");
    }
    expect(h.exec).not.toHaveBeenCalled();
  });
  it("does not trust a cleanup map injected into lease metadata", async () => {
    const c = clients();
    await expect(plugin.definition.onEnvironmentDestroyLease!({ ...params(), config: CONFIG,
      leaseMetadata: leaseMetadata({ workloadUid: undefined, legacySandboxCleanupUids: { [key]: "uid-1" } }),
    })).rejects.toThrow("operator-confirmed UID");
    expect(c.getNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

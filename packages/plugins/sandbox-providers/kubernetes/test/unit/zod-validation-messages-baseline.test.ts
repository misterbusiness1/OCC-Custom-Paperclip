import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// This standalone package cannot depend on workspace packages, so the
// dependency-free golden plumbing is imported from the monorepo source by path.
import { loadOrUpdateGolden, readZodVersion } from "../../../../../shared/src/testing/zod-baseline-golden.js";
import plugin from "../../src/plugin.js";
import { kubernetesProviderConfigSchema } from "../../src/types.js";
import { zod3ParseParams } from "../../src/zod3-compat.js";

/**
 * zod 3 -> zod 4 baseline for what operators see when a Kubernetes provider
 * config is validated: the parse result (normalized config) or the issue
 * messages and paths, for a fixed set of probe configs. Recorded on zod 3.25.76
 * with the pre-migration source; never re-record it on zod 4. Intentional
 * differences are listed in KNOWN_DIFFERENCES with a reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const GOLDEN = path.join(here, "__fixtures__", "zod3-validation-messages.json");

const PROBES: Record<string, unknown> = {
  "undefined": undefined,
  "null": null,
  "array": [],
  "empty object": {},
  "inCluster string": { inCluster: "yes" },
  "kubeconfig number": { kubeconfig: 5 },
  "namespacePrefix regex": { inCluster: true, namespacePrefix: "UPPER" },
  "companySlug regex": { inCluster: true, companySlug: "a b" },
  "imageRegistry invalid": { inCluster: true, imageRegistry: "not a url" },
  "imageRegistry padded": { inCluster: true, imageRegistry: "  https://registry.example.com/team  " },
  "imageRegistry tab": { inCluster: true, imageRegistry: "https://registry.example.com/te\tam" },
  "imageRegistry no host": { inCluster: true, imageRegistry: "mailto:ops@example.com" },
  "imageAllowList string": { inCluster: true, imageAllowList: "x" },
  "imageAllowList number entry": { inCluster: true, imageAllowList: [1] },
  "egressMode invalid": { inCluster: true, egressMode: "x" },
  "egressMode number": { inCluster: true, egressMode: 3 },
  "egressAllowCidrs invalid": { inCluster: true, egressAllowCidrs: ["bad", "10.0.0.0/8"] },
  "defaultResources wrong types": { inCluster: true, defaultResources: { requests: { cpu: 1 }, limits: [] } },
  "serviceAccountAnnotations number value": { inCluster: true, serviceAccountAnnotations: { a: 1 } },
  "serviceAccountAnnotations array": { inCluster: true, serviceAccountAnnotations: [] },
  "jobTtl negative": { inCluster: true, jobTtlSecondsAfterFinished: -1 },
  "podDeadline zero": { inCluster: true, podActivityDeadlineSec: 0 },
  "podDeadline float": { inCluster: true, podActivityDeadlineSec: 1.5 },
  "podDeadline string": { inCluster: true, podActivityDeadlineSec: "10" },
  "podDeadline NaN": { inCluster: true, podActivityDeadlineSec: Number.NaN },
  "jobTtl unsafe integer": { inCluster: true, jobTtlSecondsAfterFinished: 2 ** 60 },
  "adapterType unknown": { inCluster: true, adapterType: "nope" },
  "adapterType number": { inCluster: true, adapterType: 7 },
  "adapters object": { inCluster: true, adapters: {} },
  "adapters entry issues": {
    inCluster: true,
    adapters: [{ adapterType: "", extra: 1, other: true }, { adapterType: "codex_local", enabled: "yes", defaultEnv: { A: 1 } }],
  },
  "adapters entry missing type": { inCluster: true, adapters: [{ enabled: false }] },
  "backend invalid": { inCluster: true, backend: "pod" },
  "several issues": { inCluster: "x", egressMode: "y", podActivityDeadlineSec: -5, extraKey: 1 },
  "minimal in-cluster": { inCluster: true },
  "full config": {
    kubeconfig: "apiVersion: v1",
    namespacePrefix: "team-",
    companySlug: "acme",
    imageRegistry: "https://registry.example.com",
    imageAllowList: ["ghcr.io/acme/*"],
    imagePullSecrets: ["regcred"],
    egressAllowFqdns: ["api.example.com"],
    egressAllowCidrs: ["10.0.0.0/8"],
    egressMode: "cilium",
    defaultResources: { requests: { cpu: "500m" }, limits: { memory: "1Gi" } },
    runtimeClassName: "gvisor",
    serviceAccountAnnotations: { "eks.amazonaws.com/role-arn": "arn:aws:iam::1:role/x" },
    jobTtlSecondsAfterFinished: 60,
    podActivityDeadlineSec: 600,
    adapterType: "codex_local",
    adapters: [{ adapterType: "codex_local", runtimeImage: "ghcr.io/acme/codex:1", defaultEnv: { A: "1" } }],
    backend: "job",
  },
};

type ProbeResult =
  | { success: true; data: unknown }
  | { success: false; issues: Array<{ path: Array<string | number>; message: string }> };

/** probe -> why it intentionally differs from the zod 3 golden, and its result now. */
const KNOWN_DIFFERENCES: Record<string, { reason: string; result: ProbeResult }> = {
  "jobTtl unsafe integer": {
    reason:
      "zod 4's .int() accepts only safe integers (the same intentional difference as packages/shared " +
      "zod-format-baseline). A TTL or deadline above 2^53 - 1 seconds is not a usable value; zod 3 accepted it.",
    result: {
      success: false,
      issues: [{ path: ["jobTtlSecondsAfterFinished"], message: "Too big: expected int to be <=9007199254740991" }],
    },
  },
};

// The plugin parses provider configs with zod3ParseParams (the golden was
// recorded on zod 3, where that argument has no effect).
function runProbe(input: unknown): ProbeResult {
  const result = kubernetesProviderConfigSchema.safeParse(input, zod3ParseParams);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path as Array<string | number>, message: issue.message })),
  };
}

describe("kubernetes provider config validation messages (zod 3 baseline)", () => {
  const current = Object.fromEntries(Object.entries(PROBES).map(([name, input]) => [name, runProbe(input)]));
  const golden = loadOrUpdateGolden(GOLDEN, current, {
    zodVersion,
    note:
      "kubernetesProviderConfigSchema.safeParse results (data, or issue paths and messages) for fixed probe configs, " +
      "captured before the zod 4 migration. Do not regenerate on zod 4.",
  }).data;

  it("covers the same probes as the golden", () => {
    expect(Object.keys(current).sort()).toEqual(Object.keys(golden).sort());
  });

  for (const name of Object.keys(PROBES)) {
    it(`keeps the zod 3 result for ${name}`, () => {
      const known = KNOWN_DIFFERENCES[name];
      if (known) {
        expect(current[name]).not.toEqual(golden[name]);
        expect(current[name]).toEqual(known.result);
        return;
      }
      expect(current[name]).toEqual(golden[name]);
    });
  }

  it("reports the same messages through onEnvironmentValidateConfig", async () => {
    const input = PROBES["several issues"] as Record<string, unknown>;
    const result = await plugin.definition.onEnvironmentValidateConfig!({
      driverKey: "kubernetes",
      config: input,
    } as never);
    const expected = golden["several issues"];
    expect(expected?.success).toBe(false);
    expect(result).toEqual({
      ok: false,
      errors: expected && !expected.success ? expected.issues.map((issue) => issue.message) : [],
    });
  });
});

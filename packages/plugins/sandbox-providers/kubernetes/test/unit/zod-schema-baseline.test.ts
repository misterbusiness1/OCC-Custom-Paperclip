import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
// This standalone package cannot depend on workspace packages, so the
// dependency-free analyzer is imported from the monorepo source by path.
import {
  collectSchemaBaseline,
  diffFieldBehaviour,
  findOptionalOverDefaults,
  findUnexportedSchemaDefaults,
  zodExports,
} from "../../../../../shared/src/testing/zod-schema-baseline.js";
import { loadOrUpdateGolden, readZodVersion, type BaselineGolden } from "../../../../../shared/src/testing/zod-baseline-golden.js";
import * as adapterRegistry from "../../src/adapter-registry.js";
import * as types from "../../src/types.js";

/**
 * zod 3 -> zod 4 baseline for the Kubernetes provider config schemas, captured
 * on zod 3.25.76: omitted-key behaviour per field, unknown-key policy per
 * object and each schema's result for `undefined`/`{}`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const SCHEMA_GOLDEN = path.join(here, "__fixtures__", "zod3-schema-baseline.json");

describe("zod schema behaviour baseline (kubernetes provider)", () => {
  const roots = {
    ...zodExports(adapterRegistry as unknown as Record<string, unknown>, "adapter-registry.ts#"),
    ...zodExports(types as unknown as Record<string, unknown>, "types.ts#"),
  };
  const current = collectSchemaBaseline(z, roots, { includeRequired: false });
  const golden = loadOrUpdateGolden<BaselineGolden>(SCHEMA_GOLDEN, current, {
    zodVersion,
    note: "Behaviour of the Kubernetes provider zod schemas captured before the zod 4 migration (absent field entry = required). Re-record an intended change with PAPERCLIP_UPDATE_ZOD_GOLDENS=1.",
  }).data;

  it("keeps every field's omitted-key behaviour, object policy and root results", () => {
    expect(Object.keys(roots).length).toBeGreaterThanOrEqual(3);
    expect(diffFieldBehaviour(golden.fields, current.fields)).toEqual([]);
    expect(current.objects).toEqual(golden.objects);
    expect(current.roots).toEqual(golden.roots);
    expect(current.defaultsUnderOptional.filter((fieldPath) => current.fields[fieldPath] !== "omitted")).toEqual([]);
  });

  it("parses a minimal in-cluster config to the zod 3 defaults", () => {
    expect(types.parseKubernetesProviderConfig({ inCluster: true })).toEqual(MINIMAL_IN_CLUSTER_ZOD3);
  });

  it("only uses defaults, prefaults and partials inside exported consts", () => {
    for (const file of ["adapter-registry.ts", "types.ts"]) {
      const source = fs.readFileSync(path.join(here, "..", "..", "src", file), "utf8");
      expect(findUnexportedSchemaDefaults(source)).toEqual([]);
      expect(findOptionalOverDefaults(source)).toEqual([]);
    }
  });
});

/** parseKubernetesProviderConfig({ inCluster: true }) on zod 3.25.76. */
const MINIMAL_IN_CLUSTER_ZOD3 = {
  inCluster: true,
  namespacePrefix: "paperclip-",
  imageAllowList: [],
  imagePullSecrets: [],
  egressAllowFqdns: [],
  egressAllowCidrs: [],
  egressMode: "standard",
  serviceAccountAnnotations: {},
  jobTtlSecondsAfterFinished: 900,
  podActivityDeadlineSec: 3600,
  adapterType: "claude_local",
  backend: "sandbox-cr",
};

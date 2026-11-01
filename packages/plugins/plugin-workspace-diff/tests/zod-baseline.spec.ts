import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "@paperclipai/plugin-sdk";
import {
  collectSchemaBaseline,
  diffFieldBehaviour,
  findUnexportedSchemaDefaults,
  zodExports,
} from "@paperclipai/shared/testing/zod-schema-baseline";
import { loadOrUpdateGolden, readZodVersion, type BaselineGolden } from "@paperclipai/shared/testing/zod-baseline-golden";
import * as contracts from "../src/contracts.js";

/**
 * zod 3 -> zod 4 baseline for the workspace-diff plugin contracts (built with
 * the `z` re-exported by @paperclipai/plugin-sdk), captured on zod 3.25.76:
 * omitted-key behaviour per field, unknown-key policy per object and each
 * schema's result for `undefined`/`{}`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkDir = fs.realpathSync(path.join(here, "..", "node_modules", "@paperclipai", "plugin-sdk"));
const sdkRequire = createRequire(path.join(sdkDir, "package.json"));
const zodVersion = readZodVersion(sdkRequire.resolve("zod/package.json"));
const SCHEMA_GOLDEN = path.join(here, "__fixtures__", "zod3-schema-baseline.json");

describe("zod schema behaviour baseline (workspace-diff contracts)", () => {
  const roots = zodExports(contracts as unknown as Record<string, unknown>, "contracts.ts#");
  const current = collectSchemaBaseline(z, roots, { includeRequired: false });
  const golden = loadOrUpdateGolden<BaselineGolden>(SCHEMA_GOLDEN, current, {
    zodVersion,
    note: "Behaviour of the workspace-diff plugin contracts captured before the zod 4 migration (absent field entry = required). Re-record an intended change with PAPERCLIP_UPDATE_ZOD_GOLDENS=1.",
  }).data;

  it("keeps every field's omitted-key behaviour, object policy and root results", () => {
    expect(Object.keys(roots).length).toBeGreaterThan(5);
    expect(diffFieldBehaviour(golden.fields, current.fields)).toEqual([]);
    expect(current.objects).toEqual(golden.objects);
    expect(current.roots).toEqual(golden.roots);
    expect(current.defaultsUnderOptional.filter((fieldPath) => current.fields[fieldPath] !== "omitted")).toEqual([]);
  });

  it("only uses defaults, prefaults and partials inside exported consts", () => {
    const source = fs.readFileSync(path.join(here, "..", "src", "contracts.ts"), "utf8");
    expect(findUnexportedSchemaDefaults(source)).toEqual([]);
  });
});

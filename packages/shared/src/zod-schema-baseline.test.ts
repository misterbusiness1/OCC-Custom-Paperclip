import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectSchemaBaseline,
  defaultedSchemaExports,
  diffFieldBehaviour,
  findDefaultUnderOptional,
  findOptionalOverDefaults,
  findUnexportedSchemaDefaults,
  missingKeyBehaviour,
  zodExports,
} from "./testing/zod-schema-baseline.js";
import { loadOrUpdateGolden, readZodVersion, type BaselineGolden } from "./testing/zod-baseline-golden.js";

/**
 * zod 3 -> zod 4 behaviour baseline for every schema exported by a
 * @paperclipai/shared source module.
 *
 * The golden was captured on zod 3.25.76. It records, for every object field
 * reachable from an exported schema (or exported field map), what happens when
 * the key is omitted, plus each object's unknown-key policy and what each
 * exported schema returns for `undefined` and `{}`. zod 4 fills `.default()`
 * values that sit inside `.optional()`/`.partial()`/`.nullable()` wrappers, so
 * PATCH schemas would start overwriting stored values the caller never sent;
 * this test fails if any field's omitted-key behaviour changes.
 *
 * Adding or changing an exported schema changes the golden. Record the
 * intended change with
 *
 *   PAPERCLIP_UPDATE_ZOD_GOLDENS=1 pnpm exec vitest run --project @paperclipai/shared src/zod-schema-baseline.test.ts
 *
 * and review the diff: a new `{ "filled": ... }` entry for a field of an
 * update/patch schema means an omitted key now gets a default. The rule-based
 * tests below (no default under .optional() fills an omitted key, update
 * schemas parse {} to {}) do not depend on the golden.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const GOLDEN_FILE = path.join(here, "__fixtures__", "zod3-schema-baseline.json");

function listZodSourceModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__fixtures__" || entry.name === "testing") continue;
      out.push(...listZodSourceModules(full));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    if (/from\s+["']zod["']/.test(fs.readFileSync(full, "utf8"))) out.push(full);
  }
  return out.sort();
}

const sourceModules = listZodSourceModules(here);

const defaultedExportNames = new Set<string>();

async function collectRoots() {
  const roots: Record<string, unknown> = {};
  for (const file of sourceModules) {
    const moduleExports = (await import(file)) as Record<string, unknown>;
    Object.assign(roots, zodExports(moduleExports, `${path.relative(here, file).split(path.sep).join("/")}#`));
    for (const name of defaultedSchemaExports(moduleExports)) defaultedExportNames.add(name);
  }
  return roots;
}

describe("zod schema behaviour baseline (@paperclipai/shared)", async () => {
  const roots = await collectRoots();
  const current = collectSchemaBaseline(z, roots, { includeRequired: false });
  const golden = loadOrUpdateGolden<BaselineGolden>(GOLDEN_FILE, current, {
    zodVersion,
    note:
      "Behaviour of every exported @paperclipai/shared zod schema captured before the zod 4 migration. " +
      "fields: omitted-key behaviour per object field (absent entry = required). " +
      "First captured on zod 3.25.76 before the zod 4 migration. Re-record an intended change with PAPERCLIP_UPDATE_ZOD_GOLDENS=1; see packages/shared/src/testing/zod-baseline-golden.ts.",
  }).data;

  it("discovers the exported schemas", () => {
    expect(sourceModules.length).toBeGreaterThan(40);
    expect(Object.keys(roots).length).toBeGreaterThan(500);
    expect(Object.keys(current.roots).sort()).toEqual(Object.keys(golden.roots).sort());
  });

  it("keeps every field's omitted-key behaviour (no injected defaults, no newly required keys)", () => {
    expect(diffFieldBehaviour(golden.fields, current.fields)).toEqual([]);
  });

  it("keeps every object's unknown-key policy (strict/strip/passthrough)", () => {
    expect(current.objects).toEqual(golden.objects);
  });

  it("keeps what every exported schema returns for undefined and {}", () => {
    expect(current.roots).toEqual(golden.roots);
  });

  it("leaves every default that sits under .optional() unapplied for an omitted key", () => {
    const injected = current.defaultsUnderOptional.filter((fieldPath) => current.fields[fieldPath] !== "omitted");
    expect(injected).toEqual([]);
  });

  it("parses {} to {} for every update/patch schema that accepted {} on zod 3 with no output", () => {
    const patchRoots = Object.entries(golden.roots).filter(([name, outcome]) => {
      const exportName = name.split("#")[1] ?? "";
      return /^(update|patch)/.test(exportName)
        && "ok" in outcome.emptyObject
        && outcome.emptyObject.ok
        && JSON.stringify(outcome.emptyObject.data) === "{}";
    });
    expect(patchRoots.length).toBeGreaterThan(15);
    for (const [name] of patchRoots) {
      const result = (roots[name] as z.ZodTypeAny).safeParse({});
      expect({ name, success: result.success, data: result.success ? result.data : undefined }).toEqual({
        name,
        success: true,
        data: {},
      });
    }
  });

  it("only uses defaults, prefaults and partials inside exported consts (so the analyzer reaches them)", () => {
    const offenders = sourceModules.flatMap((file) =>
      findUnexportedSchemaDefaults(fs.readFileSync(file, "utf8")).map((line) => `${path.relative(here, file)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });

  it("never wraps a defaulted schema in .optional()/.nullish() without withoutOptionalDefault", () => {
    expect(defaultedExportNames.has("agentAdapterTypeSchema")).toBe(true);
    const offenders = sourceModules.flatMap((file) =>
      findOptionalOverDefaults(fs.readFileSync(file, "utf8"), [...defaultedExportNames]).map(
        (line) => `${path.relative(here, file)}:${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("zod schema baseline analyzer self-check", () => {
  it("detects defaults under optional wrappers and classifies omitted keys on this zod version", () => {
    const shape: Record<string, z.ZodTypeAny> = {
      optionalDefault: z.string().default("x").optional(),
      optionalNullableDefault: z.string().default("x").optional().nullable(),
      nullableDefault: z.string().default("x").nullable(),
      defaultOptional: z.string().optional().default("x"),
      plain: z.string(),
      optional: z.string().optional(),
    };
    const detected = Object.entries(shape)
      .filter(([, field]) => findDefaultUnderOptional(field))
      .map(([key]) => key);
    expect(detected).toEqual(["optionalDefault", "optionalNullableDefault"]);
    expect(missingKeyBehaviour(z, "k", shape.plain)).toBe("required");
    expect(missingKeyBehaviour(z, "k", shape.optional)).toBe("omitted");
    expect(missingKeyBehaviour(z, "k", shape.defaultOptional)).toEqual({ filled: "x" });
    expect(missingKeyBehaviour(z, "k", shape.nullableDefault)).toEqual({ filled: "x" });
  });

  it("detects a prefault under an optional wrapper when the zod version has prefault", () => {
    const base = z.object({ enabled: z.boolean().default(true) }) as unknown as {
      prefault?: (value: unknown) => { optional: () => z.ZodTypeAny };
    };
    if (typeof base.prefault !== "function") return;
    expect(findDefaultUnderOptional(base.prefault({}).optional())).toEqual({ value: {} });
  });

  it("flags a defaulted const wrapped in .optional() elsewhere, unless the default is stripped", () => {
    const source = [
      "export const stageConfigSchema = z.record(z.string(), z.unknown()).default({});",
      "const kindSchema = z",
      "  .enum([\"a\", \"b\"])",
      "  .default(\"a\")",
      "  .describe(\"kind\");",
      "const plainSchema = z.string().default(\"x\").transform((value) => value.trim());",
      "const updateSchema = z.object({",
      "  config: stageConfigSchema.optional(),",
      "  kind: kindSchema.nullish(),",
      "  wrapped: z.optional(stageConfigSchema),",
      "  nullableOptional: stageConfigSchema.nullable().optional(),",
      "  plain: plainSchema.optional(),",
      "  imported: agentAdapterTypeSchema.optional(),",
      "  guarded: withoutOptionalDefault(stageConfigSchema.optional()),",
      "});",
      "// config: stageConfigSchema.optional() in a comment is ignored",
      "export const provisionSchema = withoutFieldDefaults(z.object({",
      "  config: stageConfigSchema.optional(),",
      "}));",
    ].join("\n");
    expect(findOptionalOverDefaults(source, ["agentAdapterTypeSchema"])).toEqual([
      "8: config: stageConfigSchema.optional(),",
      "9: kind: kindSchema.nullish(),",
      "10: wrapped: z.optional(stageConfigSchema),",
      "11: nullableOptional: stageConfigSchema.nullable().optional(),",
      "13: imported: agentAdapterTypeSchema.optional(),",
    ]);
  });

  it("lists exported schemas whose outermost wrapper is a default", () => {
    expect(
      defaultedSchemaExports({
        defaulted: z.string().default("x"),
        nullableDefaulted: z.string().default("x").nullable(),
        prefaulted: z.object({ a: z.string().default("x") }).prefault({}),
        optionalDefaulted: z.string().default("x").optional(),
        plain: z.string(),
        notSchema: 1,
      }),
    ).toEqual(["defaulted", "nullableDefaulted", "prefaulted"]);
  });
});

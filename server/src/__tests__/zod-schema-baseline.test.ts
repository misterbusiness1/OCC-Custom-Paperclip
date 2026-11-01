import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectSchemaBaseline,
  diffFieldBehaviour,
  findUnexportedSchemaDefaults,
  zodExports,
} from "@paperclipai/shared/testing/zod-schema-baseline";
import { loadOrUpdateGolden, readZodVersion, type BaselineGolden } from "@paperclipai/shared/testing/zod-baseline-golden";

/**
 * zod 3 -> zod 4 behaviour baseline for the zod schemas defined locally in the
 * server (route bodies/queries, environment driver configs, ...). Same
 * contract as packages/shared/src/zod-schema-baseline.test.ts: the golden was
 * captured on zod 3.25.76 and every field's omitted-key behaviour, every
 * object's unknown-key policy and each schema's result for `undefined`/`{}`
 * must stay the same after the migration.
 *
 * routes/openapi.ts is skipped: its schemas only feed the generated OpenAPI
 * document, which openapi-zod-baseline.test.ts pins byte for byte.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const GOLDEN_FILE = path.join(here, "fixtures", "zod3-schema-baseline.json");
const SKIPPED = new Set(["routes/openapi.ts"]);

function listZodSourceModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...listZodSourceModules(full));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    const relative = path.relative(SRC, full).split(path.sep).join("/");
    if (SKIPPED.has(relative)) continue;
    if (/from\s+["']zod["']/.test(fs.readFileSync(full, "utf8"))) out.push(full);
  }
  return out.sort();
}

const sourceModules = listZodSourceModules(SRC);

describe("zod schema behaviour baseline (server)", async () => {
  const roots: Record<string, unknown> = {};
  for (const file of sourceModules) {
    const moduleExports = (await import(file)) as Record<string, unknown>;
    Object.assign(roots, zodExports(moduleExports, `${path.relative(SRC, file).split(path.sep).join("/")}#`));
  }
  const current = collectSchemaBaseline(z, roots, { includeRequired: false });
  const golden = loadOrUpdateGolden<BaselineGolden>(GOLDEN_FILE, current, {
    zodVersion,
    note:
      "Behaviour of the server's locally defined zod schemas captured before the zod 4 migration. " +
      "fields: omitted-key behaviour per object field (absent entry = required). " +
      "Do not regenerate on zod 4; see packages/shared/src/testing/zod-baseline-golden.ts.",
  }).data;

  it("discovers the server's schemas", () => {
    expect(Object.keys(roots).length).toBeGreaterThan(10);
    expect(Object.keys(current.roots).sort()).toEqual(Object.keys(golden.roots).sort());
  });

  it("keeps every field's omitted-key behaviour", () => {
    expect(diffFieldBehaviour(golden.fields, current.fields)).toEqual([]);
  });

  it("keeps every object's unknown-key policy", () => {
    expect(current.objects).toEqual(golden.objects);
  });

  it("keeps what every schema returns for undefined and {}", () => {
    expect(current.roots).toEqual(golden.roots);
  });

  it("leaves every default that sits under .optional() unapplied for an omitted key", () => {
    expect(current.defaultsUnderOptional.filter((fieldPath) => current.fields[fieldPath] !== "omitted")).toEqual([]);
  });

  it("only uses defaults, prefaults and partials inside exported consts (so the analyzer reaches them)", () => {
    const offenders = sourceModules.flatMap((file) =>
      findUnexportedSchemaDefaults(fs.readFileSync(file, "utf8")).map((line) => `${path.relative(SRC, file)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});

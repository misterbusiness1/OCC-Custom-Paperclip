import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZOD_BASELINE_UPDATE_ENV, readZodVersion } from "@paperclipai/shared/testing/zod-baseline-golden";
import { buildOpenApiDocument } from "../routes/openapi.js";

/**
 * The generated OpenAPI document must stay byte-identical to the document the
 * zod 3 converter produced (captured on zod 3.25.76 before the zod 4
 * migration). The converter in routes/openapi.ts reads zod internals, so a zod
 * upgrade can silently change or erase documented request bodies.
 *
 * Intentional differences go in INTENTIONAL_DIFFERENCES (JSON pointer ->
 * reason) and must be listed in the pull request. Regenerate the fixture only
 * on zod 3 with PAPERCLIP_UPDATE_ZOD_BASELINE=1.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zodVersion = readZodVersion(require.resolve("zod/package.json"));
const GOLDEN_FILE = path.join(here, "fixtures", "openapi-zod3-baseline.json");

const HEARTBEAT_RUNS_SUMMARY_ENUM =
  "/paths/~1api~1companies~1{companyId}~1heartbeat-runs/get/parameters/4/schema/enum";

const INTENTIONAL_DIFFERENCES: Record<string, string> = {
  // z.enum(["true", "false", "1", "0"]): zod 4 stores enum values as the keys
  // of an object, and JavaScript orders integer-like keys first, so the values
  // come out as ["0", "1", "true", "false"]. Same members (checked below);
  // JSON Schema `enum` order carries no meaning.
  [HEARTBEAT_RUNS_SUMMARY_ENUM]: "enum member order (zod 4 orders integer-like enum values first)",
};

function pointerSegments(pointer: string) {
  return pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readPointer(document: unknown, pointer: string): unknown {
  return pointerSegments(pointer).reduce<unknown>(
    (value, segment) => (value as Record<string, unknown> | undefined)?.[segment],
    document,
  );
}

function writePointer(document: unknown, pointer: string, value: unknown) {
  const segments = pointerSegments(pointer);
  const parent = segments
    .slice(0, -1)
    .reduce<unknown>((current, segment) => (current as Record<string, unknown>)[segment], document) as Record<string, unknown>;
  parent[segments[segments.length - 1]] = value;
}

function serialize(document: unknown) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function escapePointer(segment: string) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function diffPointers(expected: unknown, actual: unknown, pointer = "", out: string[] = []): string[] {
  if (out.length >= 200) return out;
  if (JSON.stringify(expected) === JSON.stringify(actual)) return out;
  const bothObjects =
    expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object"
    && Array.isArray(expected) === Array.isArray(actual);
  if (!bothObjects) {
    out.push(pointer || "/");
    return out;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)]);
  for (const key of keys) diffPointers(expectedRecord[key], actualRecord[key], `${pointer}/${escapePointer(key)}`, out);
  const expectedOrder = Object.keys(expectedRecord).join("\u0000");
  const actualOrder = Object.keys(actualRecord).join("\u0000");
  if (out.length === 0 && expectedOrder !== actualOrder) out.push(`${pointer || "/"} (key order)`);
  return out;
}

function isCoveredByIntentionalDifference(pointer: string) {
  return Object.keys(INTENTIONAL_DIFFERENCES).some(
    (allowed) => pointer === allowed || pointer.startsWith(`${allowed}/`),
  );
}

describe("OpenAPI document zod 3 baseline", () => {
  it("is byte-identical to the document generated on zod 3", () => {
    const actual = serialize(buildOpenApiDocument());
    if (process.env[ZOD_BASELINE_UPDATE_ENV] === "1") {
      if (!zodVersion.startsWith("3.")) {
        throw new Error(`${ZOD_BASELINE_UPDATE_ENV}=1 refused: the OpenAPI golden is a zod 3 baseline (running zod ${zodVersion}).`);
      }
      fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
      fs.writeFileSync(GOLDEN_FILE, actual);
    }
    const expected = fs.readFileSync(GOLDEN_FILE, "utf8");
    if (actual === expected) return;
    const differences = diffPointers(JSON.parse(expected), JSON.parse(actual)).filter(
      (pointer) => !isCoveredByIntentionalDifference(pointer),
    );
    expect(differences).toEqual([]);
    // Every remaining difference is intentional: with the golden's values put
    // back at the listed pointers, the document must be byte-identical (this
    // also catches key-order changes the pointer diff stops reporting once it
    // has found a difference).
    const goldenDocument = JSON.parse(expected) as unknown;
    const patched = JSON.parse(actual) as unknown;
    for (const pointer of Object.keys(INTENTIONAL_DIFFERENCES)) {
      writePointer(patched, pointer, readPointer(goldenDocument, pointer));
    }
    expect(serialize(patched)).toBe(expected);
  });

  it("keeps the members of enums whose order zod 4 changes", () => {
    const expected = readPointer(JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8")), HEARTBEAT_RUNS_SUMMARY_ENUM) as string[];
    const actual = readPointer(buildOpenApiDocument(), HEARTBEAT_RUNS_SUMMARY_ENUM) as string[];
    expect(expected).toEqual(["true", "false", "1", "0"]);
    expect([...actual].sort()).toEqual([...expected].sort());
  });
});

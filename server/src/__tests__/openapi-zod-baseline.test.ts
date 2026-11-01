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

const INTENTIONAL_DIFFERENCES: Record<string, string> = {};

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
    // Every remaining difference is intentional: still require the same bytes
    // outside the listed pointers, i.e. nothing beyond them changed.
    expect(Object.keys(INTENTIONAL_DIFFERENCES).length).toBeGreaterThan(0);
  });
});

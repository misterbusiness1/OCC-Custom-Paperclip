import fs from "node:fs";
import path from "node:path";
import type { SchemaBaseline } from "./zod-schema-baseline.js";

/**
 * Golden-file plumbing for the zod baseline tests.
 *
 * Test-only module: it is imported by test files (in this package, the server,
 * the MCP servers, plugin-workspace-diff, and by relative path from the
 * standalone kubernetes provider's tests, which therefore only run inside this
 * repository). It is not part of @paperclipai/shared's runtime API.
 *
 * The goldens were first captured on zod 3.25.76, before the zod 4 migration.
 * There are two kinds:
 *
 * - "contract" goldens (the default) pin what product code does today: the
 *   omitted-key behaviour of exported schemas, the generated OpenAPI document,
 *   the MCP `tools/list` result, validation-error bodies, kubernetes config
 *   messages. An intended change to a schema, a route, a tool or an error body
 *   is recorded with
 *
 *     PAPERCLIP_UPDATE_ZOD_GOLDENS=1 pnpm exec vitest run <test file>
 *
 *   (or `npx vitest run` in a package that is not in the root vitest projects),
 *   on whatever zod the workspace runs. `capturedWith` records that zod
 *   version. Review the golden diff like code. While a golden is still the zod
 *   3 capture, its test also applies the documented zod 3 -> zod 4 allowances
 *   (`isZod3Capture`); once re-recorded, the comparison is exact.
 * - "zod3-reference" goldens (the zod 3 issue probes and the format probes)
 *   hold zod 3's own output for fixed probes; the zod 3 compatibility helpers
 *   are tested against them. They are never re-recorded on zod 4:
 *   `PAPERCLIP_UPDATE_ZOD_GOLDENS=1` leaves them untouched.
 *
 * `PAPERCLIP_UPDATE_ZOD_BASELINE=1` is the original migration switch: it
 * re-records any golden, but only while the workspace runs zod 3 (a zod 3
 * checkout), and refuses on zod 4, so a migration regression cannot be
 * "fixed" by re-recording.
 */
export const ZOD_BASELINE_UPDATE_ENV = "PAPERCLIP_UPDATE_ZOD_BASELINE";
export const ZOD_GOLDEN_RERECORD_ENV = "PAPERCLIP_UPDATE_ZOD_GOLDENS";

export type GoldenKind = "contract" | "zod3-reference";

export interface GoldenFile<T> {
  capturedWith: string;
  note: string;
  data: T;
}

export function readGolden<T>(file: string): GoldenFile<T> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as GoldenFile<T>;
}

/** True when `capturedWith` (e.g. "zod@3.25.76") names a zod 3 capture. */
export function isZod3Capture(capturedWith: string | undefined): boolean {
  return typeof capturedWith === "string" && capturedWith.startsWith("zod@3.");
}

/**
 * Whether this run should (re-)write a golden of `kind`, given the running zod
 * version and the two update switches. Throws when
 * `PAPERCLIP_UPDATE_ZOD_BASELINE=1` is set on a zod other than 3.
 */
export function shouldWriteGolden(kind: GoldenKind, zodVersion: string, label = "this golden"): boolean {
  if (process.env[ZOD_BASELINE_UPDATE_ENV] === "1") {
    if (!zodVersion.startsWith("3.")) {
      throw new Error(
        `${ZOD_BASELINE_UPDATE_ENV}=1 refused: ${label} is a zod 3 baseline and must not be re-recorded on zod ${zodVersion} ` +
          `with the migration switch. After the migration, record an intended change with ${ZOD_GOLDEN_RERECORD_ENV}=1.`,
      );
    }
    return true;
  }
  return kind === "contract" && process.env[ZOD_GOLDEN_RERECORD_ENV] === "1";
}

/**
 * Returns the golden for `file`, writing `current` first when an update
 * switch applies (see the module comment).
 */
export function loadOrUpdateGolden<T>(
  file: string,
  current: T,
  options: { zodVersion: string; note: string; kind?: GoldenKind },
): GoldenFile<T> {
  if (shouldWriteGolden(options.kind ?? "contract", options.zodVersion, path.basename(file))) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const golden: GoldenFile<T> = { capturedWith: `zod@${options.zodVersion}`, note: options.note, data: current };
    fs.writeFileSync(file, `${JSON.stringify(golden, null, 1)}\n`);
  }
  return readGolden<T>(file);
}

export function readZodVersion(packageJsonPath: string): string {
  return (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string }).version;
}

export type BaselineGolden = Omit<SchemaBaseline, "defaultsUnderOptional"> & {
  /** Informational: what the structural detector found when the golden was captured. */
  defaultsUnderOptional: string[];
};

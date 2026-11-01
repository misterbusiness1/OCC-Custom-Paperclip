import fs from "node:fs";
import path from "node:path";
import type { SchemaBaseline } from "./zod-schema-baseline.js";

/**
 * Golden-file plumbing for the zod migration baseline tests.
 *
 * Goldens were captured on zod 3.25.76 before the zod 4 migration and are the
 * behaviour contract the migrated code must keep. Regenerate them only with
 * `PAPERCLIP_UPDATE_ZOD_BASELINE=1` while running on zod 3; on zod 4 the
 * update switch refuses to write, so a regression cannot be "fixed" by
 * re-recording. Intentional differences must be edited in by hand and
 * explained in the pull request.
 */
export const ZOD_BASELINE_UPDATE_ENV = "PAPERCLIP_UPDATE_ZOD_BASELINE";

export interface GoldenFile<T> {
  capturedWith: string;
  note: string;
  data: T;
}

export function readGolden<T>(file: string): GoldenFile<T> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as GoldenFile<T>;
}

/**
 * Returns the golden for `file`, writing `current` first when the update switch
 * is set and the running zod is 3.x.
 */
export function loadOrUpdateGolden<T>(
  file: string,
  current: T,
  options: { zodVersion: string; note: string },
): GoldenFile<T> {
  if (process.env[ZOD_BASELINE_UPDATE_ENV] === "1") {
    if (!options.zodVersion.startsWith("3.")) {
      throw new Error(
        `${ZOD_BASELINE_UPDATE_ENV}=1 refused: goldens are zod 3 baselines and must not be re-recorded on zod ${options.zodVersion}.`,
      );
    }
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
  /** Informational: what the structural detector found on zod 3. */
  defaultsUnderOptional: string[];
};

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZOD_BASELINE_UPDATE_ENV,
  ZOD_GOLDEN_RERECORD_ENV,
  isZod3Capture,
  loadOrUpdateGolden,
  shouldWriteGolden,
} from "./zod-baseline-golden.js";

function tempGolden(capturedWith: string, data: unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zod-golden-"));
  const file = path.join(dir, "golden.json");
  fs.writeFileSync(file, `${JSON.stringify({ capturedWith, note: "old", data }, null, 1)}\n`);
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("golden update switches", () => {
  it("re-records a contract golden on zod 4 with PAPERCLIP_UPDATE_ZOD_GOLDENS=1 and stamps the version", () => {
    vi.stubEnv(ZOD_GOLDEN_RERECORD_ENV, "1");
    const file = tempGolden("zod@3.25.76", { a: 1 });
    const golden = loadOrUpdateGolden(file, { a: 2 }, { zodVersion: "4.6.7", note: "new" });
    expect(golden).toEqual({ capturedWith: "zod@4.6.7", note: "new", data: { a: 2 } });
    expect(isZod3Capture(golden.capturedWith)).toBe(false);
  });

  it("leaves a zod 3 reference golden untouched with PAPERCLIP_UPDATE_ZOD_GOLDENS=1", () => {
    vi.stubEnv(ZOD_GOLDEN_RERECORD_ENV, "1");
    const file = tempGolden("zod@3.25.76", { a: 1 });
    const golden = loadOrUpdateGolden(file, { a: 2 }, { zodVersion: "4.6.7", note: "new", kind: "zod3-reference" });
    expect(golden).toEqual({ capturedWith: "zod@3.25.76", note: "old", data: { a: 1 } });
  });

  it("only reads the golden without a switch", () => {
    const file = tempGolden("zod@3.25.76", { a: 1 });
    expect(loadOrUpdateGolden(file, { a: 2 }, { zodVersion: "4.6.7", note: "new" }).data).toEqual({ a: 1 });
    expect(shouldWriteGolden("contract", "4.6.7")).toBe(false);
  });

  it("keeps the migration switch zod 3 only", () => {
    vi.stubEnv(ZOD_BASELINE_UPDATE_ENV, "1");
    expect(() => shouldWriteGolden("contract", "4.6.7")).toThrow(/refused/);
    expect(() => shouldWriteGolden("zod3-reference", "4.6.7")).toThrow(/refused/);
    expect(shouldWriteGolden("zod3-reference", "3.25.76")).toBe(true);
  });

  it("recognises zod 3 captures", () => {
    expect(isZod3Capture("zod@3.25.76")).toBe(true);
    expect(isZod3Capture("zod@4.6.7")).toBe(false);
    expect(isZod3Capture(undefined)).toBe(false);
  });
});

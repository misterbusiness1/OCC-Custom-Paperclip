import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirNames = new Set(["node_modules", "dist", ".git"]);
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function sourceTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirNames.has(entry.name)) files.push(...sourceTestFiles(path.join(dir, entry.name)));
    } else if (testFilePattern.test(entry.name)) {
      files.push(path.relative(packageDir, path.join(dir, entry.name)));
    }
  }
  return files.sort();
}

function collectedTestFiles(): string[] {
  const vitestCli = path.join(packageDir, "node_modules", "vitest", "vitest.mjs");
  // Drop the parent run's VITEST_* variables so the nested CLI starts clean.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
  const result = spawnSync(process.execPath, [vitestCli, "list", "--filesOnly", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    env: { ...env, CI: "1", NO_COLOR: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
  const listed = JSON.parse(result.stdout) as Array<{ file: string }>;
  return listed.map((entry) => path.relative(packageDir, entry.file)).sort();
}

describe("@paperclipai/db vitest config", () => {
  it("collects every test file in the package, including scripts/, and nothing from dist/", () => {
    const expected = sourceTestFiles(packageDir);
    expect(expected).toContain(path.join("scripts", "clean-poisoned-claude-sessions.test.ts"));
    expect(collectedTestFiles()).toEqual(expected);
  }, 60_000);
});

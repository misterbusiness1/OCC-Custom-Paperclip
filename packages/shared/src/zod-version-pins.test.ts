import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * zod is pinned to one exact version everywhere: in the root pnpm.overrides
 * (so third-party packages resolve the same copy) and in every manifest that
 * declares it. The zod 3 compatibility layer (validators/zod3-issues.ts)
 * relies on that version's internals, and Dependabot ignores zod
 * (.github/dependabot.yml), so a bump has to move all of these together.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".turbo", "coverage"]);

function findManifests(dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) out.push(...findManifests(path.join(dir, entry.name), depth + 1));
    } else if (entry.name === "package.json") {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
};

describe("zod version pins", () => {
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Manifest;
  const override = root.pnpm?.overrides?.zod;
  const manifests = ["cli", "server", "ui", "packages"].flatMap((dir) =>
    fs.existsSync(path.join(repoRoot, dir)) ? findManifests(path.join(repoRoot, dir)) : [],
  );

  it("overrides zod to one exact version", () => {
    expect(override).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(root.pnpm?.overrides ?? {}).filter((key) => key === "zod" || key.startsWith("zod@"))).toEqual(["zod"]);
  });

  it("declares exactly the overridden zod version in every manifest", () => {
    const declarations: string[] = [];
    const mismatches: string[] = [];
    for (const file of manifests) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
        const version = manifest[field]?.zod;
        if (version === undefined) continue;
        const where = `${path.relative(repoRoot, file)} ${field}`;
        declarations.push(where);
        if (version !== override) mismatches.push(`${where}: ${version}`);
      }
    }
    expect(declarations.length).toBeGreaterThanOrEqual(8);
    expect(declarations).toContain("packages/adapters/cursor-cloud/package.json dependencies");
    expect(mismatches).toEqual([]);
  });
});

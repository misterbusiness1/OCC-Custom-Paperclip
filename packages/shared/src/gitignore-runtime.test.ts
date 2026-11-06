import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("gitignore: .paperclip-runtime/", () => {
  it("ignores files under .paperclip-runtime/ via the explicit gitignore rule", () => {
    // Exercise the tracked policy in a fixture owned by the current test user.
    const fixture = mkdtempSync(path.join(os.tmpdir(), "paperclip-gitignore-"));
    try {
      writeFileSync(path.join(fixture, ".gitignore"), readFileSync(path.join(REPO_ROOT, ".gitignore")));
      const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
        cwd: fixture, encoding: "utf8",
      });
      git(["init", "--quiet"]);
      const output = git(["check-ignore", "-v", ".paperclip-runtime/codex/home/auth.json"]).trim();
      expect(output).toMatch(/^\.gitignore:\d+:\.paperclip-runtime\//);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

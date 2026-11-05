import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { planSandboxProviderRuns } from "../run-sandbox-provider-tests.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function writePackage(dir, scripts) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: path.basename(dir), scripts }));
}

function writeLockedPackage(dir, scripts) {
  writePackage(dir, scripts);
  writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
}

test("every provider with a test script is installed standalone from its frozen lockfile and tested", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-sandbox-providers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeLockedPackage(path.join(root, "locked"), { test: "vitest run" });
  writeLockedPackage(path.join(root, "group", "nested"), { test: "vitest run" });
  writePackage(path.join(root, "untested"), { build: "tsc" });
  writePackage(path.join(root, "node_modules", "dependency"), { test: "vitest run" });

  const dirs = (...parts) => path.join(root, ...parts);
  assert.deepEqual(planSandboxProviderRuns(root), [
    {
      dir: dirs("group", "nested"),
      install: ["--dir", dirs("group", "nested"), "install", "--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"],
      test: ["--dir", dirs("group", "nested"), "test"],
    },
    {
      dir: dirs("locked"),
      install: ["--dir", dirs("locked"), "install", "--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"],
      test: ["--dir", dirs("locked"), "test"],
    },
  ]);
});

test("a provider without a committed lockfile fails the plan", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-sandbox-providers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeLockedPackage(path.join(root, "locked"), { test: "vitest run" });
  writePackage(path.join(root, "unlocked"), { test: "vitest run" });
  writePackage(path.join(root, "untested"), { build: "tsc" });

  assert.throws(() => planSandboxProviderRuns(root), /without a committed pnpm-lock\.yaml: unlocked\./);
});

test("the checked-in providers install from a frozen lockfile without lifecycle scripts", () => {
  const plan = planSandboxProviderRuns();
  for (const run of plan) {
    assert.ok(!run.install.includes("--no-lockfile"), `${run.dir} must not install without a lockfile`);
    assert.ok(run.install.includes("--frozen-lockfile") && run.install.includes("--ignore-scripts"), run.install.join(" "));
  }
});

test("the checked-in sandbox providers all commit a lockfile and are planned", () => {
  const planned = planSandboxProviderRuns().map((run) => path.relative(repoRoot, run.dir).split(path.sep).join("/"));
  for (const provider of ["cloudflare", "daytona", "e2b", "exe-dev", "kubernetes", "modal", "novita"]) {
    assert.ok(
      planned.includes(`packages/plugins/sandbox-providers/${provider}`),
      `expected ${provider} in the sandbox provider plan: ${planned.join(", ")}`,
    );
  }
});

test("the PR workflow runs the provider tests and gates verify on them", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
  const job = workflow.match(/\n  sandbox_providers:\n([\s\S]*?)\n  [a-z_]+:\n/)?.[1];
  assert.ok(job, "pr.yml must define a sandbox_providers job");
  assert.match(job, /pnpm install --frozen-lockfile\n\s+pnpm --filter @paperclipai\/plugin-sdk build/);
  assert.match(job, /run: node scripts\/run-sandbox-provider-tests\.mjs/);

  const verify = workflow.match(/\n  verify:\n([\s\S]*?)\n  [a-z_]+:\n/)?.[1];
  assert.ok(verify, "pr.yml must define the verify job");
  assert.match(verify, /needs: \[[^\]]*\bsandbox_providers\b[^\]]*\]/);
  assert.match(verify, /SANDBOX_PROVIDERS_RESULT: \$\{\{ needs\.sandbox_providers\.result \}\}/);
  assert.match(verify, /test "\$SANDBOX_PROVIDERS_RESULT" = "success"/);
});

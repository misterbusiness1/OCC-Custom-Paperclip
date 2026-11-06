#!/usr/bin/env node

// Runs the tests of every sandbox-provider plugin. The providers are excluded
// from the pnpm workspace (see pnpm-workspace.yaml), so the root vitest
// projects never reach them: each one is installed standalone, gets the
// in-repo @paperclipai/plugin-sdk linked in, and runs its own `test` script.
//
// Expects the root workspace to be installed and @paperclipai/plugin-sdk built
// (`pnpm install && pnpm --filter @paperclipai/plugin-sdk build`). Every
// provider runs even after one fails; the exit status reports all of them.
//
// Reproducible installs: every provider must commit its own pnpm-lock.yaml
// (the root lockfile does not cover them), and each is installed with
// --frozen-lockfile --ignore-scripts, so CI and `pnpm ci:local` run exactly the
// reviewed dependency graph and no dependency lifecycle scripts. A provider
// without a lockfile fails the plan instead of resolving the newest in-range
// releases. To add or update one, run in the provider directory:
//   pnpm install --ignore-workspace --lockfile-only --ignore-scripts
// and commit the resulting pnpm-lock.yaml (see doc/SELF-HOSTED-CI.md).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { linkSdkInto, readPluginsUnder } from "./link-plugin-dev-sdk.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const providersRoot = join(repoRoot, "packages", "plugins", "sandbox-providers");

// One entry per provider package with a `test` script, in a stable order.
// Throws when a provider has no committed pnpm-lock.yaml.
export function planSandboxProviderRuns(parentDir = providersRoot) {
  const dirs = readPluginsUnder(parentDir)
    .filter((dir) => typeof JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.test === "string")
    .sort((left, right) => left.localeCompare(right));
  const unlocked = dirs.filter((dir) => !existsSync(join(dir, "pnpm-lock.yaml")));
  if (unlocked.length > 0) {
    throw new Error(
      `Sandbox providers without a committed pnpm-lock.yaml: ${unlocked.map((dir) => relative(parentDir, dir)).join(", ")}. ` +
        "Run `pnpm install --ignore-workspace --lockfile-only --ignore-scripts` in each and commit the lockfile.",
    );
  }
  return dirs.map((dir) => ({
    dir,
    install: ["--dir", dir, "install", "--ignore-workspace", "--frozen-lockfile", "--ignore-scripts"],
    test: ["--dir", dir, "test"],
  }));
}

function runPnpm(args) {
  const result = spawnSync("pnpm", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) {
    console.error(`[sandbox-providers] Failed to start pnpm: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  let runs;
  try {
    runs = planSandboxProviderRuns();
  } catch (error) {
    console.error(`[sandbox-providers] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (runs.length === 0) {
    console.error(`[sandbox-providers] No provider with a test script under ${relative(repoRoot, providersRoot)}`);
    process.exit(1);
  }

  const failures = [];
  for (const run of runs) {
    const name = relative(repoRoot, run.dir);
    console.log(`\n[sandbox-providers] ${name}: install`);
    if (runPnpm(run.install) !== 0) {
      failures.push(`${name} (install)`);
      continue;
    }
    // Link after installing: the provider's own install owns node_modules.
    linkSdkInto(run.dir);
    console.log(`\n[sandbox-providers] ${name}: test`);
    if (runPnpm(run.test) !== 0) {
      failures.push(`${name} (test)`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n[sandbox-providers] ${failures.length} of ${runs.length} providers failed:`);
    for (const failure of failures) console.error(`[sandbox-providers]   ${failure}`);
    process.exit(1);
  }
  console.log(`\n[sandbox-providers] ${runs.length} providers passed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

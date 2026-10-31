#!/usr/bin/env node
/**
 * run-local-ci.mjs
 *
 * Runs the same gates as .github/workflows/pr.yml on the current checkout,
 * without GitHub Actions. Use it when hosted runners are unavailable (billing
 * refusals, outages, queue delays) or to pre-flight a branch.
 *
 * With --report, each gate result is posted to GitHub as a commit status on
 * HEAD (context "local-ci/<gate>", plus an aggregate "local-ci/verify"), so a
 * PR shows the self-hosted results next to (or instead of) Actions checks.
 *
 * Usage:
 *   node scripts/ci/run-local-ci.mjs [--base <ref>] [--gates a,b,...]
 *     [--with-e2e] [--with-canary] [--report] [--keep-going] [--dry-run]
 *
 * Gates (default order): policy, install, typecheck, audit, typesafe-skill,
 * general-tests, serialized-tests, build. Opt-in: e2e (--with-e2e, needs a
 * local Chrome), canary (--with-canary, runs release.sh in a throwaway
 * worktree).
 *
 * The run is non-destructive to the working tree: a lockfile regenerated for
 * the run (as CI's policy job does) is restored afterwards.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_GATES = [
  "policy",
  "install",
  "typecheck",
  "audit",
  "typesafe-skill",
  "general-tests",
  "serialized-tests",
  "build",
];
export const OPTIONAL_GATES = ["e2e", "canary"];
const STATUS_CONTEXT_PREFIX = "local-ci";

export function parseArgs(argv) {
  const options = {
    base: "origin/master",
    gates: null,
    withE2e: false,
    withCanary: false,
    report: false,
    keepGoing: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--base") options.base = next();
    else if (arg.startsWith("--base=")) options.base = arg.slice("--base=".length);
    else if (arg === "--gates") options.gates = next().split(",").map((gate) => gate.trim()).filter(Boolean);
    else if (arg.startsWith("--gates=")) options.gates = arg.slice("--gates=".length).split(",").map((gate) => gate.trim()).filter(Boolean);
    else if (arg === "--with-e2e") options.withE2e = true;
    else if (arg === "--with-canary") options.withCanary = true;
    else if (arg === "--report") options.report = true;
    else if (arg === "--keep-going") options.keepGoing = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function selectGates(options) {
  const known = new Set([...DEFAULT_GATES, ...OPTIONAL_GATES]);
  const selected = options.gates ?? [
    ...DEFAULT_GATES,
    ...(options.withE2e ? ["e2e"] : []),
    ...(options.withCanary ? ["canary"] : []),
  ];
  for (const gate of selected) {
    if (!known.has(gate)) throw new Error(`Unknown gate "${gate}". Known gates: ${[...known].join(", ")}`);
  }
  return selected;
}

/** Mirrors pr.yml "Block manual lockfile edits". */
export function lockfileEditViolation(changedPaths, branchName) {
  if (branchName === "chore/refresh-lockfile") return null;
  return changedPaths.includes("pnpm-lock.yaml")
    ? "Do not commit pnpm-lock.yaml in pull requests. CI owns lockfile updates."
    : null;
}

/** owner/repo from an https or ssh GitHub remote URL. */
export function parseGitHubRemote(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function run(command, args, opts = {}) {
  const printable = [command, ...args].join(" ");
  console.log(`\n$ ${printable}`);
  if (opts.dryRun) return { status: 0 };
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

function capture(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: opts.cwd ?? repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function steps(list, opts) {
  for (const [command, args, extra] of list) {
    const result = run(command, args, { ...opts, ...(extra ?? {}) });
    if (result.status !== 0) return false;
  }
  return true;
}

function gatePolicy(ctx) {
  const changed = ctx.changedPaths;
  const violation = lockfileEditViolation(changed, ctx.branch);
  if (violation) {
    console.error(violation);
    return false;
  }
  return steps(
    [
      ["node", ["./scripts/check-docker-deps-stage.mjs"]],
      ["node", ["./scripts/check-no-git-push.mjs"]],
      ["node", ["--test", "./scripts/check-no-git-push.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/run-vitest-stable-shard.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/e2e-shard.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/release-verify-workflow.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/pr-lockfile-workflow.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/build-standalone-concurrency.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/run-local-ci.test.mjs"]],
      ["node", ["./scripts/release-package-map.mjs", "check"]],
      [
        "node",
        ["./scripts/check-release-package-bootstrap.mjs", ...changed],
        { env: { PAPERCLIP_RELEASE_BOOTSTRAP_BASE_SHA: ctx.baseSha } },
      ],
    ],
    ctx,
  );
}

function gateInstall(ctx) {
  // Same as the policy job's "Qualify dependency lockfile": regenerate the
  // lockfile for this checkout, then install frozen against it. The original
  // lockfile bytes are restored when the run ends.
  if (!steps([["pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"]]], ctx)) return false;
  return steps([["pnpm", ["install", "--frozen-lockfile"]]], ctx);
}

const GATES = {
  policy: gatePolicy,
  install: gateInstall,
  typecheck: (ctx) =>
    steps([["pnpm", ["run", "typecheck:build-gaps"]], ["pnpm", ["run", "test:release-registry"]]], ctx),
  audit: (ctx) => steps([["pnpm", ["run", "audit:prod"]]], ctx),
  "typesafe-skill": (ctx) => {
    const dir = "packages/plugins/plugin-typesafe-skill-suggestion";
    if (!existsSync(path.join(repoRoot, dir, "package.json"))) {
      console.log(`${dir} not present; skipping.`);
      return true;
    }
    const ok = steps(
      [
        ["pnpm", ["--dir", dir, "install", "--ignore-workspace", "--frozen-lockfile"]],
        ["node", ["scripts/link-plugin-dev-sdk.mjs"]],
        ["pnpm", ["--filter", "@paperclipai/plugin-sdk", "build"]],
        ["pnpm", ["--ignore-workspace", "--dir", dir, "audit", "--prod", "--audit-level=high"]],
        ["pnpm", ["--dir", dir, "test"]],
        ["pnpm", ["--dir", dir, "typecheck"]],
        ["pnpm", ["--dir", dir, "build"]],
      ],
      ctx,
    );
    if (!ok || ctx.dryRun) return ok;
    return ["manifest.js", "worker.js"].every((file) => existsSync(path.join(repoRoot, dir, "dist", file)));
  },
  "general-tests": (ctx) => steps([["pnpm", ["test:run:general"]]], ctx),
  "serialized-tests": (ctx) => steps([["pnpm", ["test:run:serialized"]]], ctx),
  build: (ctx) => steps([["pnpm", ["build"]]], ctx),
  e2e: (ctx) => {
    // Isolated Paperclip home so the run never touches the operator's own
    // ~/.paperclip instance (CI writes the same config into a fresh runner).
    const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-local-ci-e2e-"));
    const instanceDir = path.join(home, ".paperclip", "instances", "default");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      path.join(instanceDir, "config.json"),
      JSON.stringify(
        {
          $meta: { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", source: "onboard" },
          database: { mode: "embedded-postgres" },
          logging: { mode: "file" },
          server: { deploymentMode: "local_trusted", host: "127.0.0.1", port: 3100 },
          auth: { baseUrlMode: "auto" },
          storage: { provider: "local_disk" },
          secrets: { provider: "local_encrypted", strictMode: false },
        },
        null,
        2,
      ),
    );
    try {
      return steps(
        [["pnpm", ["run", "test:e2e"], { env: { HOME: home, PAPERCLIP_E2E_SKIP_LLM: "true", PAPERCLIP_PLAYWRIGHT_CHANNEL: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL ?? "chrome" } }]],
        ctx,
      );
    } finally {
      if (!ctx.dryRun) rmSync(home, { recursive: true, force: true });
    }
  },
  canary: (ctx) => {
    // release.sh needs a clean tree on a branch named master; do that in a
    // throwaway worktree so the caller's checkout and branches are untouched.
    const worktree = mkdtempSync(path.join(os.tmpdir(), "paperclip-local-ci-canary-"));
    rmSync(worktree, { recursive: true, force: true });
    const ok = steps(
      [
        ["git", ["worktree", "add", "--detach", worktree, "HEAD"]],
        ["git", ["checkout", "-B", "local-ci-canary-master"], { cwd: worktree }],
        ["pnpm", ["install", "--frozen-lockfile"], { cwd: worktree }],
        ["./scripts/release.sh", ["canary", "--skip-verify", "--dry-run"], { cwd: worktree }],
      ],
      ctx,
    );
    if (!ctx.dryRun) {
      spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot });
      spawnSync("git", ["branch", "-D", "local-ci-canary-master"], { cwd: repoRoot });
    }
    return ok;
  },
};

function postStatus(ctx, gate, state, description) {
  if (!ctx.report) return;
  const contextName = `${STATUS_CONTEXT_PREFIX}/${gate}`;
  const args = [
    "api",
    `repos/${ctx.repo}/statuses/${ctx.headSha}`,
    "-f", `state=${state}`,
    "-f", `context=${contextName}`,
    "-f", `description=${description.slice(0, 139)}`,
  ];
  if (ctx.dryRun) {
    console.log(`[report] gh ${args.join(" ")}`);
    return;
  }
  const result = spawnSync("gh", args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    console.warn(`[report] failed to post ${contextName}: ${result.stderr || result.stdout}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    return 0;
  }
  const gates = selectGates(options);
  const baseSha = capture("git", ["merge-base", options.base, "HEAD"]);
  const headSha = capture("git", ["rev-parse", "HEAD"]);
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const changedPaths = capture("git", ["diff", "--name-only", `${baseSha}...HEAD`]).split("\n").filter(Boolean);
  const repo = options.report ? parseGitHubRemote(capture("git", ["remote", "get-url", "origin"])) : null;
  if (options.report && !repo) throw new Error("--report needs an origin remote on github.com");

  const ctx = { ...options, baseSha, headSha, branch, changedPaths, repo };
  const lockfilePath = path.join(repoRoot, "pnpm-lock.yaml");
  const originalLockfile = existsSync(lockfilePath) ? readFileSync(lockfilePath) : null;

  console.log(`local CI for ${branch} @ ${headSha.slice(0, 12)} (base ${baseSha.slice(0, 12)}): ${gates.join(", ")}`);
  for (const gate of gates) postStatus(ctx, gate, "pending", "Queued on self-hosted local CI");

  const results = [];
  try {
    for (const gate of gates) {
      const started = Date.now();
      console.log(`\n=== [local-ci] ${gate} ===`);
      let ok = false;
      try {
        ok = await GATES[gate](ctx);
      } catch (error) {
        console.error(error);
        ok = false;
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      results.push({ gate, ok, seconds });
      postStatus(ctx, gate, ok ? "success" : "failure", `${ok ? "Passed" : "Failed"} in ${seconds}s on self-hosted local CI`);
      if (!ok && !options.keepGoing) break;
    }
  } finally {
    if (originalLockfile && !options.dryRun) writeFileSync(lockfilePath, originalLockfile);
  }

  const skipped = gates.filter((gate) => !results.some((result) => result.gate === gate));
  for (const gate of skipped) postStatus(ctx, gate, "error", "Not run: an earlier local CI gate failed");
  const allPassed = skipped.length === 0 && results.every((result) => result.ok);
  postStatus(ctx, "verify", allPassed ? "success" : "failure", allPassed ? "All local CI gates passed" : "One or more local CI gates failed");

  console.log("\n=== [local-ci] summary ===");
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.gate}  (${result.seconds}s)`);
  for (const gate of skipped) console.log(`SKIP  ${gate}`);
  return allPassed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}

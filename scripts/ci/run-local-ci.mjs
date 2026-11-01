#!/usr/bin/env node
/**
 * run-local-ci.mjs
 *
 * Runs the same gates as .github/workflows/pr.yml on the current checkout,
 * without GitHub Actions. Use it when hosted runners are unavailable (billing
 * refusals, outages, queue delays) or to pre-flight a branch.
 *
 * Usage:
 *   pnpm ci:local [--base <ref>] [--gates a,b,...] [--with-e2e]
 *     [--with-canary] [--report] [--keep-going] [--dry-run]
 *
 * Gates (default order): policy, install, typecheck, audit, typesafe-skill,
 * sandbox-providers, general-tests, serialized-tests, build. Opt-in: e2e
 * (--with-e2e, needs a local Chrome), canary (--with-canary, runs release.sh in a throwaway clone
 * of HEAD).
 *
 * What is tested: the working tree (HEAD plus uncommitted changes; the canary
 * gate uses HEAD only). Pull request CI tests the merge of the PR with its
 * base branch instead, so rebase first if the base has moved.
 *
 * With --report, results are posted as informational commit statuses on HEAD
 * ("local-ci/<gate>"). This needs a clean working tree, and the aggregate
 * "local-ci/verify" is only posted when every default gate ran. Statuses are
 * self-reported by whoever runs this; they are not an Actions check.
 *
 * The run leaves the working tree as it found it: a lockfile regenerated for
 * the run (as CI's policy job does) is restored afterwards, also on Ctrl-C or
 * SIGTERM (exit 130/143), and temporary directories are removed.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "sandbox-providers",
  "general-tests",
  "serialized-tests",
  "build",
];
export const OPTIONAL_GATES = ["e2e", "canary"];

/**
 * Every pr.yml job, mapped to the local gates that run its commands. Aggregate
 * jobs that only check other jobs' results map to []. The test suite fails when
 * pr.yml gains a job or a command that is missing here.
 */
export const PR_JOB_GATES = {
  policy: ["policy", "install"],
  typecheck_release_registry: ["install", "typecheck"],
  dependency_audit: ["install", "audit"],
  typesafe_skill_suggestion: ["install", "typesafe-skill"],
  sandbox_providers: ["install", "sandbox-providers"],
  general_tests: ["install", "general-tests"],
  verify: [],
  build: ["install", "build"],
  verify_serialized_server: ["install", "serialized-tests"],
  canary_dry_run: ["canary"],
  e2e_shards: ["install", "e2e"],
  e2e: [],
};

const STATUS_CONTEXT_PREFIX = "local-ci";
const STATUS_LABEL = "Informational, self-reported by pnpm ci:local: ";
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const LOCKFILE_QUALIFY = ["pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"]];

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
  // `pnpm ci:local -- --flag` forwards the literal `--` to the script.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[index + 1];
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

/** The aggregate local-ci/verify status only means something when every default gate ran. */
export function coversDefaultGates(gates) {
  return DEFAULT_GATES.every((gate) => gates.includes(gate));
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

/**
 * Environment for gates that boot Paperclip or its test suites. The server and
 * `onboard` prefer DATABASE_URL over embedded Postgres, and PAPERCLIP_* points
 * at instance homes, configs and secrets, so an operator's exported values
 * could aim tests at a real database or instance. CI runners have none of
 * them; neither do these gates, apart from what the gate sets itself.
 */
export function isolatedEnv(baseEnv, gateEnv = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key === "DATABASE_URL" || key === "DATABASE_MIGRATION_URL" || key.startsWith("PAPERCLIP_")) continue;
    env[key] = value;
  }
  return { ...env, ...gateEnv };
}

// ---------------------------------------------------------------------------
// Interrupt handling. Children run asynchronously so SIGINT/SIGTERM reach this
// process while a gate is running; the signal is forwarded to the active
// child, its gate unwinds through its `finally` blocks, and registered cleanups
// (lockfile restore, temporary clones) run before exiting with 130/143. A
// second signal skips the wait for the child and cleans up immediately.

class Interrupted extends Error {
  constructor(signal) {
    super(`Interrupted by ${signal}`);
    this.signal = signal;
  }
}

const cleanupTasks = [];
let interruptedBy = null;
let activeChild = null;

/** Registers a synchronous cleanup. The returned function runs it at most once. */
function onCleanup(task) {
  let done = false;
  const runOnce = () => {
    if (done) return;
    done = true;
    const index = cleanupTasks.indexOf(runOnce);
    if (index !== -1) cleanupTasks.splice(index, 1);
    try {
      task();
    } catch (error) {
      console.error(`[local-ci] cleanup failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  cleanupTasks.push(runOnce);
  return runOnce;
}

function handleSignal(signal) {
  if (interruptedBy) {
    activeChild?.kill("SIGKILL");
    while (cleanupTasks.length > 0) cleanupTasks[cleanupTasks.length - 1]();
    process.exit(SIGNAL_EXIT_CODES[interruptedBy]);
  }
  interruptedBy = signal;
  console.error(`\n[local-ci] ${signal} received: stopping and cleaning up (send it again to force)`);
  activeChild?.kill(signal);
}

function childEnv(opts) {
  const env = opts.isolated ? isolatedEnv(process.env, opts.env) : { ...process.env, ...(opts.env ?? {}) };
  for (const key of opts.unsetEnv ?? []) delete env[key];
  return env;
}

function run(command, args, opts = {}) {
  const cwd = opts.cwd ?? repoRoot;
  console.log(`\n$ ${[command, ...args].join(" ")}${cwd === repoRoot ? "" : `   # in ${cwd}`}`);
  if (opts.dryRun) return Promise.resolve({ status: 0, signal: null });
  if (interruptedBy) return Promise.reject(new Interrupted(interruptedBy));
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      fn(value);
    };
    const child = spawn(command, args, { cwd, stdio: "inherit", env: childEnv(opts), shell: false });
    activeChild = child;
    child.once("error", (error) => settle(reject, error));
    child.once("close", (status, signal) => {
      // Let a signal delivered to this process alongside the child (Ctrl-C
      // reaches the whole process group) be handled before deciding.
      setImmediate(() => {
        if (interruptedBy) settle(reject, new Interrupted(interruptedBy));
        else settle(resolve, { status, signal });
      });
    });
  });
}

function capture(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: opts.cwd ?? repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function steps(list, ctx) {
  for (const [command, args, extra] of list) {
    const result = await run(command, args, { ...ctx, ...(extra ?? {}) });
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
      ["node", ["--test", "./scripts/__tests__/run-vitest-stable-projects.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/run-sandbox-provider-tests.test.mjs"]],
      ["node", ["--test", "./scripts/__tests__/overlay-image-workflow.test.mjs"]],
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

async function gateInstall(ctx) {
  // Same as the policy job's "Qualify dependency lockfile": regenerate the
  // lockfile for this checkout, then install frozen against it. The original
  // lockfile bytes are restored when the run ends; the canary gate reuses the
  // qualified one, as pr.yml does with the policy job's artifact.
  if (!(await steps([LOCKFILE_QUALIFY], ctx))) return false;
  if (!ctx.dryRun) ctx.qualifiedLockfile = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"));
  return steps([["pnpm", ["install", "--frozen-lockfile"]]], ctx);
}

async function gateTypesafeSkill(ctx) {
  const dir = "packages/plugins/plugin-typesafe-skill-suggestion";
  if (!existsSync(path.join(repoRoot, dir, "package.json"))) {
    console.log(`${dir} not present; skipping.`);
    return true;
  }
  const ok = await steps(
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
}

function gateE2e(ctx) {
  // tests/e2e/playwright.config.ts boots the server in its own temporary
  // PAPERCLIP_HOME/PAPERCLIP_CONFIG, so no config or HOME is prepared here.
  // PAPERCLIP_E2E_PORT (default 3199) is passed through so two runs on one
  // host can use different ports.
  const env = {
    PAPERCLIP_E2E_SKIP_LLM: "true",
    PAPERCLIP_PLAYWRIGHT_CHANNEL: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL || "chrome",
    ...(process.env.PAPERCLIP_E2E_PORT ? { PAPERCLIP_E2E_PORT: process.env.PAPERCLIP_E2E_PORT } : {}),
  };
  return steps([["pnpm", ["run", "test:e2e"], { isolated: true, env }]], ctx);
}

async function gateCanary(ctx) {
  // release.sh insists on a clean tree on a branch named exactly `master`, and
  // it runs `git fetch --prune --tags` against its remote. Do all of that in a
  // throwaway clone of HEAD, whose only remote is this checkout, so the
  // caller's working tree, branches, tags and remote-tracking refs are never
  // touched. Mirrors pr.yml's canary_dry_run job.
  const clone = ctx.dryRun
    ? path.join(os.tmpdir(), "paperclip-local-ci-canary-XXXXXX")
    : mkdtempSync(path.join(os.tmpdir(), "paperclip-local-ci-canary-"));
  const removeClone = ctx.dryRun ? () => {} : onCleanup(() => rmSync(clone, { recursive: true, force: true }));
  try {
    const inClone = { cwd: clone };
    const cloned = await steps(
      [
        ["git", ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, clone]],
        ["git", ["checkout", "--quiet", "-B", "master", ctx.headSha], inClone],
      ],
      ctx,
    );
    if (!cloned) return false;

    // pr.yml stages the policy job's regenerated lockfile into an ephemeral
    // commit so release.sh sees a clean tree and a lockfile matching the
    // manifests. Reuse the install gate's lockfile, or qualify one here.
    if (ctx.qualifiedLockfile) {
      console.log("\n[local-ci] using the lockfile qualified by the install gate");
      writeFileSync(path.join(clone, "pnpm-lock.yaml"), ctx.qualifiedLockfile);
    } else if (!(await steps([[...LOCKFILE_QUALIFY, inClone]], ctx))) {
      return false;
    }
    if (!(await steps([["git", ["add", "pnpm-lock.yaml"], inClone]], ctx))) return false;
    const staged = await run("git", ["diff", "--cached", "--quiet"], { ...ctx, ...inClone });
    if (staged.status !== 0 && staged.status !== 1) return false;
    if (staged.status === 1) {
      const committed = await steps(
        [
          [
            "git",
            ["-c", "user.email=ci@paperclip.local", "-c", "user.name=CI", "commit", "--quiet", "--no-verify", "-m", "ci(canary): stage regenerated lockfile"],
            inClone,
          ],
        ],
        ctx,
      );
      if (!committed) return false;
    }

    // Install from this checkout's pnpm store: when TMPDIR is on another
    // filesystem, pnpm would otherwise create and fill a second store there.
    const storeDir = ctx.dryRun ? "<pnpm store path>" : capture("pnpm", ["store", "path"]);
    return await steps(
      [
        ["pnpm", ["install", "--frozen-lockfile", "--store-dir", storeDir], inClone],
        // The clone's only remote is origin; a remote override from the
        // caller's shell would not exist there.
        ["./scripts/release.sh", ["canary", "--skip-verify", "--dry-run"], { ...inClone, unsetEnv: ["RELEASE_REMOTE", "PUBLISH_REMOTE"] }],
      ],
      ctx,
    );
  } finally {
    removeClone();
  }
}

const GATES = {
  policy: gatePolicy,
  install: gateInstall,
  typecheck: (ctx) =>
    steps([["pnpm", ["run", "typecheck:build-gaps"]], ["pnpm", ["run", "test:release-registry"]]], ctx),
  audit: (ctx) => steps([["pnpm", ["run", "audit:prod"]]], ctx),
  "typesafe-skill": gateTypesafeSkill,
  "sandbox-providers": (ctx) =>
    steps(
      [
        ["pnpm", ["--filter", "@paperclipai/plugin-sdk", "build"]],
        ["node", ["scripts/run-sandbox-provider-tests.mjs"]],
      ],
      { ...ctx, isolated: true },
    ),
  "general-tests": (ctx) => steps([["pnpm", ["test:run:general"], { isolated: true }]], ctx),
  "serialized-tests": (ctx) => steps([["pnpm", ["test:run:serialized"], { isolated: true }]], ctx),
  build: (ctx) => steps([["pnpm", ["build"]]], ctx),
  e2e: gateE2e,
  canary: gateCanary,
};

function postStatus(ctx, gate, state, description) {
  if (!ctx.report) return;
  const contextName = `${STATUS_CONTEXT_PREFIX}/${gate}`;
  const args = [
    "api",
    `repos/${ctx.repo}/statuses/${ctx.headSha}`,
    "-f", `state=${state}`,
    "-f", `context=${contextName}`,
    "-f", `description=${`${STATUS_LABEL}${description}`.slice(0, 140)}`,
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
  if (options.report) {
    // Statuses are attached to HEAD; results from uncommitted or untracked
    // changes would be credited to a commit that does not contain them.
    const dirty = capture("git", ["status", "--porcelain"]);
    if (dirty) {
      throw new Error(`--report needs a clean working tree (statuses are posted on HEAD). Commit or remove:\n${dirty}`);
    }
  }
  const reportVerify = options.report && coversDefaultGates(gates);

  const ctx = { ...options, baseSha, headSha, branch, changedPaths, repo, qualifiedLockfile: null };
  const lockfilePath = path.join(repoRoot, "pnpm-lock.yaml");
  const originalLockfile = existsSync(lockfilePath) ? readFileSync(lockfilePath) : null;

  console.log(`local CI for ${branch} @ ${headSha.slice(0, 12)} (base ${baseSha.slice(0, 12)}): ${gates.join(", ")}`);
  if (options.report && !reportVerify) {
    console.log(`[report] ${STATUS_CONTEXT_PREFIX}/verify is not posted: it needs every default gate (${DEFAULT_GATES.join(", ")}).`);
  }
  for (const gate of gates) postStatus(ctx, gate, "pending", "queued");
  if (reportVerify) postStatus(ctx, "verify", "pending", "queued");

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  const restoreLockfile = originalLockfile && !options.dryRun
    ? onCleanup(() => writeFileSync(lockfilePath, originalLockfile))
    : () => {};
  const results = [];
  try {
    for (const gate of gates) {
      if (interruptedBy) break;
      const started = Date.now();
      console.log(`\n=== [local-ci] ${gate} ===`);
      let ok = false;
      try {
        ok = await GATES[gate](ctx);
      } catch (error) {
        if (error instanceof Interrupted) break;
        console.error(error);
        ok = false;
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      results.push({ gate, ok, seconds });
      postStatus(ctx, gate, ok ? "success" : "failure", `${ok ? "passed" : "failed"} in ${seconds}s`);
      if (!ok && !options.keepGoing) break;
    }
  } finally {
    restoreLockfile();
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }

  const skipped = gates.filter((gate) => !results.some((result) => result.gate === gate));
  const skipReason = interruptedBy ? `not finished: run interrupted by ${interruptedBy}` : "not run: an earlier gate failed";
  for (const gate of skipped) postStatus(ctx, gate, "error", skipReason);
  const allPassed = !interruptedBy && skipped.length === 0 && results.every((result) => result.ok);
  if (reportVerify) {
    postStatus(
      ctx,
      "verify",
      interruptedBy ? "error" : allPassed ? "success" : "failure",
      interruptedBy ? skipReason : allPassed ? "all default gates passed" : "one or more gates failed",
    );
  }

  console.log("\n=== [local-ci] summary ===");
  for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.gate}  (${result.seconds}s)`);
  for (const gate of skipped) console.log(`${interruptedBy ? "STOP" : "SKIP"}  ${gate}`);
  if (interruptedBy) return SIGNAL_EXIT_CODES[interruptedBy];
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

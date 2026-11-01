import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GATES,
  PR_JOB_GATES,
  coversDefaultGates,
  isolatedEnv,
  lockfileEditViolation,
  parseArgs,
  parseGitHubRemote,
  selectGates,
} from "../ci/run-local-ci.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const runnerSource = path.join(repoRoot, "scripts", "ci", "run-local-ci.mjs");

test("defaults to every pr.yml verify gate in CI order", () => {
  assert.deepEqual(selectGates(parseArgs([])), DEFAULT_GATES);
  assert.deepEqual(DEFAULT_GATES, [
    "policy",
    "install",
    "typecheck",
    "audit",
    "typesafe-skill",
    "sandbox-providers",
    "general-tests",
    "serialized-tests",
    "build",
  ]);
});

test("optional gates are opt-in", () => {
  assert.deepEqual(selectGates(parseArgs(["--with-e2e", "--with-canary"])).slice(-2), ["e2e", "canary"]);
  assert.deepEqual(selectGates(parseArgs(["--gates", "policy,build"])), ["policy", "build"]);
  assert.throws(() => selectGates(parseArgs(["--gates", "lint"])), /Unknown gate "lint"/);
});

test("parses flags and rejects unknown arguments", () => {
  const options = parseArgs(["--base=origin/main", "--report", "--keep-going", "--dry-run"]);
  assert.equal(options.base, "origin/main");
  assert.equal(options.report, true);
  assert.equal(options.keepGoing, true);
  assert.equal(options.dryRun, true);
  assert.throws(() => parseArgs(["--base"]), /requires a value/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("accepts the literal -- that `pnpm ci:local -- ...` forwards", () => {
  const options = parseArgs(["--", "--dry-run", "--gates", "policy"]);
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.gates, ["policy"]);
  assert.throws(() => parseArgs(["--dry-run", "--"]), /Unknown argument: --/);
});

test("mirrors the PR lockfile policy", () => {
  assert.match(lockfileEditViolation(["pnpm-lock.yaml", "package.json"], "fix/x"), /CI owns lockfile updates/);
  assert.equal(lockfileEditViolation(["package.json"], "fix/x"), null);
  assert.equal(lockfileEditViolation(["pnpm-lock.yaml"], "chore/refresh-lockfile"), null);
});

test("derives owner/repo from GitHub remotes", () => {
  assert.equal(parseGitHubRemote("https://github.com/misterbusiness1/OCC-Custom-Paperclip"), "misterbusiness1/OCC-Custom-Paperclip");
  assert.equal(parseGitHubRemote("https://github.com/acme/repo.git"), "acme/repo");
  assert.equal(parseGitHubRemote("git@github.com:acme/repo.git"), "acme/repo");
  assert.equal(parseGitHubRemote("https://gitlab.com/acme/repo"), null);
});

test("the aggregate verify status needs every default gate", () => {
  assert.equal(coversDefaultGates(DEFAULT_GATES), true);
  assert.equal(coversDefaultGates([...DEFAULT_GATES, "e2e"]), true);
  assert.equal(coversDefaultGates(["policy"]), false);
  assert.equal(coversDefaultGates(DEFAULT_GATES.filter((gate) => gate !== "build")), false);
});

test("isolated gate env drops database and instance settings but keeps the gate's own", () => {
  const env = isolatedEnv(
    { PATH: "/bin", HOME: "/home/op", DATABASE_URL: "postgres://op", DATABASE_MIGRATION_URL: "postgres://op", PAPERCLIP_HOME: "/home/op/.paperclip" },
    { PAPERCLIP_E2E_SKIP_LLM: "true" },
  );
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/op", PAPERCLIP_E2E_SKIP_LLM: "true" });
});

// ---------------------------------------------------------------------------
// pr.yml coverage: every job maps to local gates, and every node/pnpm/release
// command of a job is executed by those gates (checked through --dry-run).

function prWorkflowJobs() {
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  for (const line of readFileSync(path.join(repoRoot, ".github", "workflows", "pr.yml"), "utf8").split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inJobs = false;
      current = null;
      continue;
    }
    if (!inJobs) continue;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
    } else if (current) {
      jobs.get(current).push(line);
    }
  }
  return jobs;
}

function jobCommands(lines) {
  const scriptLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(- )?run: ?(.*)$/.exec(lines[index]);
    if (!match) continue;
    const keyIndent = match[1].length + (match[2] ? 2 : 0);
    if (!/^[|>][-+]?$/.test(match[3])) {
      scriptLines.push(match[3]);
      continue;
    }
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next.trim() !== "" && next.length - next.trimStart().length <= keyIndent) break;
      scriptLines.push(next);
      index += 1;
    }
  }
  const commands = new Set();
  for (const raw of scriptLines) {
    let command = raw.trim().replace(/\s*\\$/, "");
    if (!/^(?:node|pnpm|\.\/scripts\/)\s?/.test(command)) continue;
    // Matrix/shard pass-through arguments and shell expansions are CI-only.
    for (const stop of [" -- ", ' "$', " $"]) {
      const at = command.indexOf(stop);
      if (at !== -1) command = command.slice(0, at);
    }
    commands.add(command.trim());
  }
  return [...commands];
}

test("every pr.yml job maps to local gates that run its commands", () => {
  const jobs = prWorkflowJobs();
  assert.deepEqual([...jobs.keys()].sort(), Object.keys(PR_JOB_GATES).sort(), "pr.yml jobs and PR_JOB_GATES diverged");
  for (const gates of Object.values(PR_JOB_GATES)) {
    for (const gate of gates) assert.ok(selectGates({ gates: [gate] }), gate);
  }

  const dryRun = spawnSync(process.execPath, [runnerSource, "--dry-run", "--base", "HEAD", "--with-e2e", "--with-canary"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const executed = new Map();
  let gate = null;
  for (const line of dryRun.stdout.split("\n")) {
    const header = /^=== \[local-ci\] (\S+) ===$/.exec(line);
    if (header) {
      gate = header[1];
      executed.set(gate, []);
    } else if (gate && line.startsWith("$ ")) {
      executed.get(gate).push(line.slice(2).replace(/\s+# in .*$/, ""));
    }
  }

  let checked = 0;
  for (const [job, lines] of jobs) {
    const ran = PR_JOB_GATES[job].flatMap((name) => executed.get(name) ?? []);
    for (const command of jobCommands(lines)) {
      checked += 1;
      assert.ok(
        ran.some((line) => line === command || line.startsWith(`${command} `)),
        `pr.yml job ${job} runs \`${command}\`, but local gates ${JSON.stringify(PR_JOB_GATES[job])} do not`,
      );
    }
  }
  assert.ok(checked >= 25, `expected to check the pr.yml commands, only found ${checked}`);
});

// ---------------------------------------------------------------------------
// Self-hosted routing: only unprivileged verification workflows may follow
// PAPERCLIP_CI_RUNS_ON (doc/SELF-HOSTED-CI.md). A runner that ran a PR job must
// never later run a job holding credentials.

const SELF_HOSTABLE_WORKFLOWS = ["pr.yml", "release-verify.yml"];
const RUNS_ON_SWITCH =
  "${{ (vars.PAPERCLIP_CI_RUNS_ON != '' && (!github.event.pull_request || github.event.pull_request.head.repo.full_name == github.repository)) && fromJSON(vars.PAPERCLIP_CI_RUNS_ON) || 'ubuntu-latest' }}";

test("only unprivileged verification workflows can be routed to self-hosted runners", () => {
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const switched = [];
  for (const name of readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const text = readFileSync(path.join(workflowsDir, name), "utf8");
    if (text.includes("PAPERCLIP_CI_RUNS_ON")) switched.push(name);
    if (!SELF_HOSTABLE_WORKFLOWS.includes(name)) continue;
    assert.doesNotMatch(text, /pull_request_target/, `${name} must not run on pull_request_target`);
    assert.doesNotMatch(text, /\bsecrets\./, `${name} must not use secrets`);
    assert.doesNotMatch(text, /^\s+[a-z-]+:\s*write\s*$/m, `${name} must not request write permissions`);
    const runsOn = text.split("\n").filter((line) => /^\s+runs-on:/.test(line));
    assert.ok(runsOn.length > 0, name);
    for (const line of runsOn) assert.equal(line.trim(), `runs-on: ${RUNS_ON_SWITCH}`, `${name}: ${line.trim()}`);
  }
  assert.deepEqual(switched, SELF_HOSTABLE_WORKFLOWS);
  // pr.yml has no job-level permissions, so pin the token for every job.
  assert.match(
    readFileSync(path.join(workflowsDir, "pr.yml"), "utf8"),
    /^permissions:\n {2}contents: read\n\njobs:$/m,
  );
});

test("pr.yml e2e shards do not write into the runner user's home", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "pr.yml"), "utf8");
  assert.doesNotMatch(workflow, /~\/\.paperclip|\$HOME\/\.paperclip/);
});

// ---------------------------------------------------------------------------
// Behaviour of a real run, in a throwaway repository with a copy of the runner
// and fake pnpm/gh executables that log every call.

const FAKE_PNPM = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(DATABASE_|PAPERCLIP_)/.test(key)));
fs.appendFileSync(process.env.LOCAL_CI_FIXTURE_LOG, JSON.stringify({ tool: "pnpm", cwd: process.cwd(), args, env, home: process.env.HOME }) + "\\n");
if (args[0] === "store" && args[1] === "path") console.log("/fake/pnpm-store");
if (args.includes("--lockfile-only")) fs.writeFileSync("pnpm-lock.yaml", "regenerated-lockfile\\n");
if (process.env.LOCAL_CI_FIXTURE_HANG && args.join(" ").startsWith(process.env.LOCAL_CI_FIXTURE_HANG)) {
  console.log("FIXTURE_READY");
  setTimeout(() => process.exit(0), 20000);
}
`;

const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.LOCAL_CI_FIXTURE_LOG, JSON.stringify({ tool: "gh", args: process.argv.slice(2) }) + "\\n");
`;

const FAKE_RELEASE = `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$(git symbolic-ref --short HEAD)" "$(git status --porcelain | wc -l | tr -d ' ')" "$(cat pnpm-lock.yaml)" "$(pwd)" >> "$LOCAL_CI_FIXTURE_LOG.release"
exit "\${LOCAL_CI_FIXTURE_RELEASE_EXIT:-0}"
`;

function fixture(t, { release = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-local-ci-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const tmp = path.join(root, "tmp");
  const log = path.join(root, "calls.log");
  mkdirSync(path.join(repo, "scripts", "ci"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(tmp);
  copyFileSync(runnerSource, path.join(repo, "scripts", "ci", "run-local-ci.mjs"));
  writeFileSync(path.join(repo, "package.json"), '{"name":"local-ci-fixture","private":true}\n');
  writeFileSync(path.join(repo, "pnpm-lock.yaml"), "committed-lockfile\n");
  writeFileSync(path.join(repo, "scripts", "run-sandbox-provider-tests.mjs"), `
import { appendFileSync } from "node:fs";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(DATABASE_|PAPERCLIP_)/.test(key)));
appendFileSync(process.env.LOCAL_CI_FIXTURE_LOG, JSON.stringify({ tool: "sandbox-providers", env }) + "\\n");
process.exit(Number(process.env.LOCAL_CI_FIXTURE_PROVIDER_EXIT ?? 0));
`);
  if (release) {
    writeFileSync(path.join(repo, "scripts", "release.sh"), FAKE_RELEASE);
    chmodSync(path.join(repo, "scripts", "release.sh"), 0o755);
  }
  for (const [name, source] of [["pnpm", FAKE_PNPM], ["gh", FAKE_GH]]) {
    writeFileSync(path.join(bin, name), source);
    chmodSync(path.join(bin, name), 0o755);
  }
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("remote", "add", "origin", "https://github.com/acme/repo.git");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const env = {
    ...isolatedEnv(process.env),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TMPDIR: tmp,
    LOCAL_CI_FIXTURE_LOG: log,
  };
  delete env.RELEASE_REMOTE;
  delete env.PUBLISH_REMOTE;
  const script = path.join(repo, "scripts", "ci", "run-local-ci.mjs");
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const releaseRuns = () => {
    try {
      return readFileSync(`${log}.release`, "utf8").trim().split("\n").map((line) => {
        const [branch, dirty, lockfile, cwd] = line.split("|");
        return { branch, dirty: Number(dirty), lockfile, cwd };
      });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    repo,
    tmp,
    env,
    git,
    calls,
    releaseRuns,
    lockfile: () => readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8"),
    run: (args, extraEnv = {}) =>
      spawnSync(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8" }),
    spawn: (args, extraEnv = {}) =>
      spawn(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] }),
  };
}

function statusCalls(calls) {
  return calls
    .filter((call) => call.tool === "gh")
    .map((call) => {
      const fields = Object.fromEntries(
        call.args.filter((_, index) => call.args[index - 1] === "-f").map((field) => field.split(/=(.*)/s).slice(0, 2)),
      );
      return { endpoint: call.args[1], ...fields };
    });
}

async function interruptWhenReady(child, signal) {
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture never became ready:\n${output}`)), 15000);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes("FIXTURE_READY")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => (output += chunk));
  });
  child.kill(signal);
  const [code, exitSignal] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("runner did not exit after the signal")), 15000);
    child.once("exit", (exitCode, killedBy) => {
      clearTimeout(timer);
      resolve([exitCode, killedBy]);
    });
  });
  return { code, signal: exitSignal, output };
}

test("canary runs release.sh on master in a throwaway clone with the qualified lockfile committed", (t) => {
  const f = fixture(t);
  const before = { branches: f.git("branch", "--list"), worktrees: f.git("worktree", "list"), head: f.git("rev-parse", "HEAD") };
  const result = f.run(["--gates", "canary", "--base", "HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const [release] = f.releaseRuns();
  assert.ok(release, "release.sh did not run");
  assert.equal(release.branch, "master");
  assert.equal(release.dirty, 0, "release.sh requires a clean tree");
  assert.equal(release.lockfile, "regenerated-lockfile", "the canary must install against the qualified lockfile");
  assert.notEqual(path.resolve(release.cwd), path.resolve(f.repo));
  const install = f.calls().find((call) => call.tool === "pnpm" && call.args.includes("--frozen-lockfile"));
  assert.deepEqual(install.args, ["install", "--frozen-lockfile", "--store-dir", "/fake/pnpm-store"]);

  assert.equal(f.lockfile(), "committed-lockfile\n");
  assert.deepEqual(
    { branches: f.git("branch", "--list"), worktrees: f.git("worktree", "list"), head: f.git("rev-parse", "HEAD") },
    before,
    "the caller's branches, worktrees and HEAD must be untouched",
  );
  assert.deepEqual(readdirSync(f.tmp), [], "the canary clone must be removed");
});

test("canary reuses the lockfile the install gate qualified", (t) => {
  const f = fixture(t);
  const result = f.run(["--gates", "install,canary", "--base", "HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.releaseRuns()[0]?.lockfile, "regenerated-lockfile");
  const resolutions = f.calls().filter((call) => call.tool === "pnpm" && call.args.includes("--lockfile-only"));
  assert.equal(resolutions.length, 1, "the canary must not resolve the lockfile a second time");
  assert.equal(f.lockfile(), "committed-lockfile\n", "the regenerated lockfile is restored after the run");
});

test("canary removes its clone when release.sh is missing or fails", (t) => {
  const missing = fixture(t, { release: false });
  const result = missing.run(["--gates", "canary", "--base", "HEAD"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(missing.tmp), []);
  assert.equal(missing.git("branch", "--list").trim(), "* master");

  const failing = fixture(t);
  const failed = failing.run(["--gates", "canary", "--base", "HEAD"], { LOCAL_CI_FIXTURE_RELEASE_EXIT: "1" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failing.releaseRuns().length, 1);
  assert.deepEqual(readdirSync(failing.tmp), []);
});

test("SIGTERM restores the regenerated lockfile and exits 143", async (t) => {
  const f = fixture(t);
  const child = f.spawn(["--gates", "install", "--base", "HEAD"], { LOCAL_CI_FIXTURE_HANG: "install --frozen-lockfile" });
  const { code, signal, output } = await interruptWhenReady(child, "SIGTERM");
  assert.equal(signal, null, `runner was killed by ${signal} instead of handling it:\n${output}`);
  assert.equal(code, 143, output);
  assert.equal(f.lockfile(), "committed-lockfile\n");
});

test("SIGINT during the canary removes the clone and exits 130", async (t) => {
  const f = fixture(t);
  const child = f.spawn(["--gates", "canary", "--base", "HEAD"], { LOCAL_CI_FIXTURE_HANG: "install --frozen-lockfile" });
  const { code, signal, output } = await interruptWhenReady(child, "SIGINT");
  assert.equal(signal, null, `runner was killed by ${signal} instead of handling it:\n${output}`);
  assert.equal(code, 130, output);
  assert.deepEqual(readdirSync(f.tmp), []);
  assert.equal(f.releaseRuns().length, 0);
  assert.equal(f.lockfile(), "committed-lockfile\n");
});

test("--dry-run creates no temporary directories", (t) => {
  const f = fixture(t);
  const result = f.run(["--dry-run", "--base", "HEAD", "--with-e2e", "--with-canary"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(f.tmp), []);
  assert.deepEqual(f.calls(), [], "a dry run must not execute gate commands");
});

test("test, provider and e2e gates never inherit the operator's database or Paperclip instance", (t) => {
  const f = fixture(t);
  const result = f.run(["--gates", "general-tests,serialized-tests,sandbox-providers,e2e", "--base", "HEAD"], {
    DATABASE_URL: "postgres://operator@db.internal/prod",
    DATABASE_MIGRATION_URL: "postgres://operator@db.internal/prod",
    PAPERCLIP_HOME: "/home/operator/.paperclip",
    PAPERCLIP_CONFIG: "/home/operator/.paperclip/instances/default/config.json",
    PAPERCLIP_E2E_PORT: "4319",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pnpmCalls = f.calls().filter((call) => call.tool === "pnpm");
  const byScript = (name) => pnpmCalls.find((call) => call.args.includes(name));
  assert.deepEqual(byScript("test:run:general").env, {});
  assert.deepEqual(byScript("test:run:serialized").env, {});
  assert.deepEqual(byScript("@paperclipai/plugin-sdk").env, {});
  assert.deepEqual(f.calls().find((call) => call.tool === "sandbox-providers").env, {});
  const e2e = byScript("test:e2e");
  assert.deepEqual(e2e.env, {
    PAPERCLIP_E2E_SKIP_LLM: "true",
    PAPERCLIP_PLAYWRIGHT_CHANNEL: "chrome",
    PAPERCLIP_E2E_PORT: "4319",
  });
  assert.equal(e2e.home, f.env.HOME, "playwright.config.ts already isolates PAPERCLIP_HOME; HOME is left alone");
});

test("--report refuses a dirty working tree before posting anything", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.repo, "untracked.txt"), "not committed\n");
  const result = f.run(["--report", "--gates", "audit", "--base", "HEAD"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /clean working tree/);
  assert.deepEqual(f.calls(), []);
});

test("--report posts informational per-gate statuses and no aggregate for a subset of gates", (t) => {
  const f = fixture(t);
  const result = f.run(["--report", "--gates", "audit", "--base", "HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const head = f.git("rev-parse", "HEAD");
  const statuses = statusCalls(f.calls());
  assert.deepEqual(
    statuses.map(({ endpoint, state, context }) => ({ endpoint, state, context })),
    [
      { endpoint: `repos/acme/repo/statuses/${head}`, state: "pending", context: "local-ci/audit" },
      { endpoint: `repos/acme/repo/statuses/${head}`, state: "success", context: "local-ci/audit" },
    ],
  );
  for (const status of statuses) {
    assert.match(status.description, /^Informational, self-reported/);
    assert.ok(status.description.length <= 140);
  }
});

test("--report posts local-ci/verify only when every default gate ran", (t) => {
  const f = fixture(t);
  const result = f.run(["--report", "--dry-run", "--base", "HEAD"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\[report\] gh api repos\/acme\/repo\/statuses\/\S+ -f state=success -f context=local-ci\/verify/);

  const subset = f.run(["--report", "--dry-run", "--gates", "policy", "--base", "HEAD"]);
  assert.equal(subset.status, 0, subset.stdout + subset.stderr);
  assert.doesNotMatch(subset.stdout, /context=local-ci\/verify/);
  assert.match(subset.stdout, /local-ci\/verify is not posted/);
});

test("provider failures prevent aggregate verification success", (t) => {
  const f = fixture(t);
  const result = f.run(["--report", "--gates", "sandbox-providers", "--base", "HEAD"], {
    LOCAL_CI_FIXTURE_PROVIDER_EXIT: "1",
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(statusCalls(f.calls()).map(({ context, state }) => ({ context, state })), [
    { context: "local-ci/sandbox-providers", state: "pending" },
    { context: "local-ci/sandbox-providers", state: "failure" },
  ]);
  assert.equal(coversDefaultGates(DEFAULT_GATES.filter((gate) => gate !== "sandbox-providers")), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_GATES,
  lockfileEditViolation,
  parseArgs,
  parseGitHubRemote,
  selectGates,
} from "../ci/run-local-ci.mjs";

test("defaults to every pr.yml verify gate in CI order", () => {
  assert.deepEqual(selectGates(parseArgs([])), DEFAULT_GATES);
  assert.deepEqual(DEFAULT_GATES, [
    "policy",
    "install",
    "typecheck",
    "audit",
    "typesafe-skill",
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

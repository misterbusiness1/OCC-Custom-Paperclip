import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
const qualification = workflow.slice(workflow.indexOf("        id: regen_lockfile"));
const run = qualification.match(/        run: \|\n((?:          .*\n|\n)+)/)?.[1];
assert.ok(run, "the canonical lockfile qualification step must exist");
const shell = run.split("\n").map((line) => line.startsWith("          ") ? line.slice(10) : line).join("\n");

function fixture(t, { manifestChanged = false, stale = false, fail = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "paperclip-pr-lockfile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(path.join(root, "package.json"), '{"name":"lockfile-test","private":true}\n');
  writeFileSync(path.join(root, "pnpm-lock.yaml"), stale ? "old-resolution\n" : "qualified-resolution\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, manifestChanged ? "package.json" : "source.txt"), manifestChanged ? '{"name":"changed-manifest","private":true}\n' : "source-only change\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(root, "resolved.yaml"), "qualified-resolution\n");
  writeFileSync(path.join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--frozen-lockfile")) {
  process.exit(fs.readFileSync("pnpm-lock.yaml", "utf8") === fs.readFileSync("resolved.yaml", "utf8") ? 0 : 42);
}
fs.writeFileSync("resolver-args.json", JSON.stringify(args));
if (process.env.PAPERCLIP_LOCKFILE_FIXTURE_FAIL === "1") process.exit(23);
fs.copyFileSync("resolved.yaml", "pnpm-lock.yaml");
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: path.join(root, "outputs"), PAPERCLIP_LOCKFILE_FIXTURE_FAIL: fail ? "1" : "0" };
  const command = shell.replaceAll("${{ github.event.pull_request.base.sha }}", base).replaceAll("${{ github.event.pull_request.head.sha }}", head);
  const result = spawnSync("bash", ["-e", "-c", command], { cwd: root, env, encoding: "utf8" });
  return { root, env, result, output: () => readFileSync(env.GITHUB_OUTPUT, "utf8") };
}

function assertResolver(root) {
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "resolver-args.json"), "utf8")), ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"]);
}

test("source-only PR repairs a stale base graph and its artifact makes frozen installation succeed", (t) => {
  const f = fixture(t, { stale: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.output(), "regenerated=1\n");
  assertResolver(f.root);
  const artifact = path.join(f.root, "artifact.yaml");
  copyFileSync(path.join(f.root, "pnpm-lock.yaml"), artifact);
  writeFileSync(path.join(f.root, "pnpm-lock.yaml"), "old-resolution\n");
  assert.equal(spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: f.root, env: f.env }).status, 42);
  copyFileSync(artifact, path.join(f.root, "pnpm-lock.yaml"));
  assert.equal(spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: f.root, env: f.env }).status, 0);
});

test("unchanged graph is still validated and does not need an artifact", (t) => {
  const f = fixture(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.output(), "regenerated=0\n");
  assertResolver(f.root);
});

test("PR manifest changes retain the same generated artifact contract", (t) => {
  const f = fixture(t, { stale: true, manifestChanged: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.output(), "regenerated=1\n");
  assertResolver(f.root);
});

test("resolver errors fail policy without claiming a qualified graph", (t) => {
  const f = fixture(t, { fail: true });
  assert.equal(f.result.status, 23);
  assert.throws(f.output, { code: "ENOENT" });
});

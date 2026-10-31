import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const skippedDirNames = new Set(["node_modules", "dist", ".git"]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function packageName(dir) {
  return readJson(path.join(repoRoot, dir, "package.json")).name;
}

function dryRunJson(args) {
  const result = spawnSync(process.execPath, [script, ...args, "--dry-run"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// The root vitest.config.ts `projects` entries. Only plain string paths are
// supported; anything else fails here so this check is updated with it.
function vitestConfigProjects() {
  const source = readFileSync(path.join(repoRoot, "vitest.config.ts"), "utf8");
  const body = source.match(/projects:\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(body !== undefined, "vitest.config.ts must declare test.projects");
  const literal = /"([^"]+)"|'([^']+)'/g;
  assert.equal(
    body.replace(literal, "").replace(/\/\/.*$/gm, "").replace(/[\s,]/g, ""),
    "",
    "vitest.config.ts projects must be plain string paths",
  );
  return [...body.matchAll(literal)].map((match) => match[1] ?? match[2]);
}

// Expands the pnpm-workspace.yaml `packages` globs. Only the `dir/*` include
// form and `!dir` / `!dir/**` excludes are used today; anything else fails.
function workspacePackageDirs() {
  const source = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const section = source.match(/^packages:\n((?:[ \t]+.*\n|[ \t]*\n)+)/m)?.[1];
  assert.ok(section, "pnpm-workspace.yaml must declare packages");
  const patterns = [...section.matchAll(/^\s*-\s*["']?([^"'#\s]+)["']?/gm)].map((match) => match[1]);
  const includes = [];
  const excludes = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      const excluded = pattern.slice(1).replace(/\/\*\*$/, "");
      assert.ok(!excluded.includes("*"), `unsupported workspace exclude: ${pattern}`);
      excludes.push(excluded);
      continue;
    }
    const parent = pattern.replace(/\/\*$/, "");
    assert.ok(!parent.includes("*"), `unsupported workspace include: ${pattern}`);
    if (parent === pattern) {
      includes.push(pattern);
      continue;
    }
    for (const entry of readdirSync(path.join(repoRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) includes.push(`${parent}/${entry.name}`);
    }
  }
  return includes
    .filter((dir) => existsSync(path.join(repoRoot, dir, "package.json")))
    .filter((dir) => !excludes.some((excluded) => dir === excluded || dir.startsWith(`${excluded}/`)))
    .sort();
}

// True when the package owns at least one test file, ignoring build output,
// dependencies and nested packages (which are their own projects).
function hasTestFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      if (skippedDirNames.has(entry) || existsSync(path.join(absolute, "package.json"))) continue;
      if (hasTestFiles(absolute)) return true;
    } else if (testFilePattern.test(entry)) {
      return true;
    }
  }
  return false;
}

test("every workspace package with tests is a root vitest project", () => {
  const projects = new Set(vitestConfigProjects());
  const workspaceDirs = workspacePackageDirs();
  assert.ok(workspaceDirs.length > 0, "expected workspace packages");

  const missing = workspaceDirs.filter((dir) => hasTestFiles(path.join(repoRoot, dir)) && !projects.has(dir));
  assert.deepEqual(missing, [], "add these packages to the projects in vitest.config.ts and to nonServerProjects in scripts/run-vitest-stable.mjs");

  const outsideWorkspace = [...projects].filter((dir) => !workspaceDirs.includes(dir));
  assert.deepEqual(outsideWorkspace, [], "vitest.config.ts projects must be workspace packages");
});

test("the workspace test groups run every non-server vitest project exactly once", () => {
  const plan = dryRunJson(["--mode", "general", "--group", "general-workspaces-b"]);
  const grouped = [...plan.generalWorkspacesAProjects, ...plan.generalWorkspacesBProjects];
  assert.equal(new Set(grouped).size, grouped.length, `a project is listed twice: ${grouped.join(", ")}`);

  // Vitest names a directory project after its package.json name.
  const expected = vitestConfigProjects()
    .filter((dir) => dir !== "server")
    .map(packageName);
  assert.deepEqual(
    [...grouped].sort(),
    [...expected].sort(),
    "nonServerProjects in scripts/run-vitest-stable.mjs must match the non-server projects in vitest.config.ts",
  );
});

// Runs the real script with a fake `pnpm` on PATH that records each Vitest
// invocation and fails the requested projects.
function runWithFakePnpm(t, args, failingProjects) {
  const bin = mkdtempSync(path.join(os.tmpdir(), "paperclip-fake-pnpm-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, "invocations.jsonl");
  writeFileSync(path.join(bin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PNPM_LOG, JSON.stringify(args) + "\\n");
const project = args[args.indexOf("--project") + 1];
process.exit(JSON.parse(process.env.FAKE_PNPM_FAIL).includes(project) ? 3 : 0);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FAKE_PNPM_LOG: log,
      FAKE_PNPM_FAIL: JSON.stringify(failingProjects),
    },
    encoding: "utf8",
  });
  // The script gives each invocation a /tmp/pcvt-<pid>-* root; drop them.
  if (process.platform !== "win32" && result.pid) {
    for (const entry of readdirSync("/tmp")) {
      if (entry.startsWith(`pcvt-${result.pid}-`)) rmSync(path.join("/tmp", entry), { recursive: true, force: true });
    }
  }
  const invocations = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { result, projects: invocations.map((args) => args[args.indexOf("--project") + 1]) };
}

test("a failing workspace project does not stop the rest of its group", (t) => {
  const { generalWorkspacesBProjects: groupB } = dryRunJson(["--mode", "general", "--group", "general-workspaces-b"]);
  const failing = [groupB[0], groupB[Math.floor(groupB.length / 2)]];

  const { result, projects } = runWithFakePnpm(t, ["--mode", "general", "--group", "general-workspaces-b"], failing);

  assert.deepEqual(projects, groupB, "every project in the group must run even after a failure");
  assert.equal(result.status, 3, "the group must exit with the first failing project's status");
  assert.match(result.stderr, new RegExp(`general-workspaces-b: 2 of ${groupB.length} projects failed`));
  for (const project of failing) {
    assert.ok(result.stderr.includes(`${project} (exit 3)`), `summary must name ${project}: ${result.stderr}`);
  }
});

test("a passing workspace group exits cleanly", (t) => {
  const { generalWorkspacesAProjects: groupA } = dryRunJson(["--mode", "general", "--group", "general-workspaces-a"]);

  const { result, projects } = runWithFakePnpm(t, ["--mode", "general", "--group", "general-workspaces-a"], []);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(projects, groupA);
  assert.doesNotMatch(result.stderr, /projects failed/);
});

test("serialized server suites still stop at the first failure", (t) => {
  const { result, projects } = runWithFakePnpm(
    t,
    ["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"],
    ["@paperclipai/server"],
  );

  assert.equal(result.status, 3);
  assert.deepEqual(projects, ["@paperclipai/server"], "serialized mode must not keep running after a failure");
});

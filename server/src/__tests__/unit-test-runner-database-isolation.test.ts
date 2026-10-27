import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");

// This exercises the installed server dependency graph. The policy job's pure
// Node tests separately verify the environment passed across the runner boundary.
test("stable unit runner keeps real config embedded despite ambient URLs and checkout dotenv", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-database-"));
  try {
    const fakeBin = path.join(tempRoot, "bin");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(path.join(tempRoot, "server", "src", "__tests__"), { recursive: true });
    writeFileSync(path.join(tempRoot, ".env"), [
      "DATABASE_URL=postgres://invalid.example/checkout",
      "DATABASE_MIGRATION_URL=postgres://invalid.example/checkout-migration",
    ].join("\n") + "\n");
    const capturePath = path.join(tempRoot, "config-capture.json");
    const probe = [
      `import { loadConfig } from ${JSON.stringify(path.join(repoRoot, "server", "src", "config.ts"))};`,
      "const config = loadConfig();",
      "console.log(JSON.stringify({ mode: config.databaseMode, hasUrl: Boolean(config.databaseUrl), hasMigrationUrl: Boolean(config.databaseMigrationUrl) }));",
    ].join("\n");
    const fakePnpm = path.join(fakeBin, "pnpm");
    writeFileSync(fakePnpm, [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      `const result = spawnSync(process.execPath, [${JSON.stringify(path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "cli.mjs"))}, "--eval", ${JSON.stringify(probe)}], { encoding: "utf8", env: process.env });`,
      'fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));',
      "process.exit(result.status ?? 1);",
    ].join("\n") + "\n");
    chmodSync(fakePnpm, 0o700);
    const result = spawnSync(process.execPath, [script, "--watch", "--"], {
      cwd: tempRoot, encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, CAPTURE_PATH: capturePath,
        DATABASE_URL: "postgres://invalid.example/ambient",
        DATABASE_MIGRATION_URL: "postgres://invalid.example/migration",
        PAPERCLIP_TEST_DATABASE_URL: "postgres://invalid.example/test",
        PAPERCLIP_TOOL_ACCESS_TEST_DATABASE_URL: "postgres://invalid.example/tool-access",
        TEST_DATABASE_URL: "postgres://invalid.example/fixture",
        PAPERCLIP_CONFIG: "/production/config.json", PAPERCLIP_DISABLE_CWD_ENV: "false",
        PAPERCLIP_DISABLE_CWD_ENV_FILE: "false" },
    });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(readFileSync(capturePath, "utf8"));
    assert.equal(captured.status, 0, captured.stderr);
    assert.deepEqual(JSON.parse(captured.stdout), { mode: "embedded-postgres", hasUrl: false, hasMigrationUrl: false });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

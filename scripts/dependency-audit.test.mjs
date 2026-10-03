import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { evaluateAuditResult } from "./dependency-audit.mjs";

function report(overrides = {}) {
  return {
    advisories: {
      1: { id: 1, module_name: "low-example", severity: "low" },
      2: { id: 2, module_name: "moderate-example", severity: "moderate" },
    },
    metadata: { vulnerabilities: { info: 0, low: 1, moderate: 1, high: 0, critical: 0 } },
    ...overrides,
  };
}

test("accepts a nonzero audit exit containing only lower-severity findings", () => {
  assert.deepEqual(
    evaluateAuditResult({ report: report(), status: 1, signal: null, processError: undefined }),
    { info: 0, low: 1, moderate: 1, high: 0, critical: 0 },
  );
});

test("fails closed on an unsupported audit report", () => {
  assert.throws(
    () => evaluateAuditResult({ report: {}, status: 1, signal: null }),
    /unsupported report shape/,
  );
});

test("blocks metadata counts even when advisory records are empty", () => {
  const inconsistent = report({
    advisories: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
  });
  assert.throws(
    () => evaluateAuditResult({ report: inconsistent, status: 1, signal: null }),
    /1 high, 0 critical/,
  );
});

test("blocks advisory records even when metadata counts are zero", () => {
  const inconsistent = report({
    advisories: { 3: { id: 3, module_name: "example", severity: "high" } },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
  });
  assert.throws(
    () => evaluateAuditResult({ report: inconsistent, status: 1, signal: null }),
    /example/,
  );
});

test("fails closed on process errors, malformed severities, and inconsistent exits", () => {
  assert.throws(
    () => evaluateAuditResult({ report: report(), status: 2, signal: null }),
    /exited unexpectedly/,
  );
  assert.throws(
    () => evaluateAuditResult({
      report: report({ advisories: { 1: { module_name: "example", severity: "unknown" } } }),
      status: 1,
      signal: null,
    }),
    /malformed advisory record/,
  );
  assert.throws(
    () => evaluateAuditResult({ report: report(), status: 0, signal: null }),
    /inconsistent with its JSON report/,
  );
});

test("CLI fails closed for a nonzero process with hidden blocking metadata", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "paperclip-audit-fixture-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const fakePnpm = path.join(fixture, "pnpm");
  const payload = JSON.stringify({
    advisories: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
  });
  writeFileSync(fakePnpm, `#!/bin/sh\nprintf '%s' '${payload}'\nexit 1\n`);
  chmodSync(fakePnpm, 0o755);

  const result = spawnSync(process.execPath, ["scripts/dependency-audit.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, PATH: `${fixture}:${process.env.PATH}` },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /1 high, 0 critical/);
  assert.doesNotMatch(result.stdout, /passed/);
});

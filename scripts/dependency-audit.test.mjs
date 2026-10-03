import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAudit } from "./dependency-audit.mjs";

const exception = {
  advisory: "GHSA-ch52-4w7c-c8xp",
  module: "http-cache-semantics",
  severity: "high",
  expiresOn: "2026-10-17",
  rationale: "Temporary exception while no upstream patched release exists.",
  dependencyPath: [
    "sqlite3@5.1.7",
    "node-gyp@8.4.1",
    "make-fetch-happen@9.1.0",
    "http-cache-semantics@4.2.0",
  ],
};

function advisory(ghsa = exception.advisory) {
  return {
    advisories: {
      1: {
        id: 1,
        github_advisory_id: ghsa,
        module_name: "http-cache-semantics",
        severity: "high",
      },
    },
  };
}

const whyReport = [{
  dependencies: {
    "drizzle-orm": {
      version: "0.45.2",
      dependencies: {
        sqlite3: {
          version: "5.1.7",
          dependencies: {
            "node-gyp": {
              version: "8.4.1",
              dependencies: {
                "make-fetch-happen": {
                  version: "9.1.0",
                  dependencies: { "http-cache-semantics": { version: "4.2.0" } },
                },
              },
            },
          },
        },
      },
    },
  },
}];

test("accepts only the exact unexpired advisory and observed path", () => {
  const accepted = evaluateAudit({
    auditReport: advisory(),
    whyReport,
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-03",
  });
  assert.equal(accepted[0].advisory, exception.advisory);
  assert.equal(accepted[0].observedPath, exception.dependencyPath.join(" -> "));
});

test("fails closed for an unrelated high advisory", () => {
  assert.throws(() => evaluateAudit({
    auditReport: advisory("GHSA-zzzz-yyyy-xxxx"),
    whyReport,
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-03",
  }), /is not allowlisted/);
});

test("fails closed after the exception expiry", () => {
  assert.throws(() => evaluateAudit({
    auditReport: advisory(),
    whyReport,
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-18",
  }), /expired on 2026-10-17/);
});

test("fails closed when the observed dependency path drifts", () => {
  const driftedWhy = structuredClone(whyReport);
  driftedWhy[0].dependencies["drizzle-orm"].dependencies.sqlite3.version = "5.2.0";
  assert.throws(() => evaluateAudit({
    auditReport: advisory(),
    whyReport: driftedWhy,
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-03",
  }), /was not found at the allowlisted dependency path/);
});

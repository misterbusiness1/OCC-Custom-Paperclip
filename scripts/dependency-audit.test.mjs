import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAudit, runDependencyAudit } from "./dependency-audit.mjs";

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
    whyReports: { "http-cache-semantics": whyReport },
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-03",
  });
  assert.equal(accepted[0].advisory, exception.advisory);
  assert.equal(accepted[0].observedPath, exception.dependencyPath.join(" -> "));
});

test("fails closed for an unrelated high advisory", () => {
  assert.throws(() => evaluateAudit({
    auditReport: advisory("GHSA-zzzz-yyyy-xxxx"),
    whyReports: { "http-cache-semantics": whyReport },
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-03",
  }), /is not allowlisted/);
});

test("fails closed after the exception expiry", () => {
  assert.throws(() => evaluateAudit({
    auditReport: advisory(),
    whyReports: { "http-cache-semantics": whyReport },
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-18",
  }), /expired on 2026-10-17/);
});

test("fails closed when the observed dependency path drifts", () => {
  const driftedWhy = structuredClone(whyReport);
  driftedWhy[0].dependencies["drizzle-orm"].dependencies.sqlite3.version = "5.2.0";
  assert.throws(() => evaluateAudit({
    auditReport: advisory(),
    whyReports: { "http-cache-semantics": driftedWhy },
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-03",
  }), /was not found at the allowlisted dependency path/);
});

test("fails closed when an approved path coexists with a non-allowlisted runtime path", () => {
  const multiPathWhy = structuredClone(whyReport);
  multiPathWhy[0].dependencies["runtime-client"] = {
    version: "1.0.0",
    dependencies: { "http-cache-semantics": { version: "4.2.0" } },
  };

  assert.throws(() => evaluateAudit({
    auditReport: advisory(),
    whyReports: { "http-cache-semantics": multiPathWhy },
    allowlist: { schemaVersion: 1, exceptions: [exception] },
    today: "2026-10-03",
  }), /was found at a non-allowlisted dependency path: runtime-client@1\.0\.0 -> http-cache-semantics@4\.2\.0/);
});

const zodException = {
  advisory: "GHSA-mrhx-c7xc-m3w5",
  module: "zod",
  severity: "high",
  expiresOn: "2026-10-17",
  rationale: "Temporary exception while no patched zod 3.x release exists.",
  dependencyPath: ["@paperclipai/shared@0.0.0", "zod@3.25.76"],
};

const zodWhyReport = [{
  dependencies: {
    "@paperclipai/shared": {
      version: "0.0.0",
      dependencies: { zod: { version: "3.25.76" } },
    },
  },
}];

function auditReportFor(...advisories) {
  return {
    advisories: Object.fromEntries(advisories.map((item, index) => [index + 1, {
      id: index + 1,
      github_advisory_id: item.advisory,
      module_name: item.module,
      severity: item.severity,
    }])),
  };
}

function fakePnpm({ auditReport, whyReports }) {
  const whyModules = [];
  const run = (command, args) => {
    assert.equal(command, "pnpm");
    if (args[0] === "audit") return auditReport;
    assert.deepEqual([args[0], args[1], ...args.slice(3)], ["-r", "why", "--prod", "--json"]);
    whyModules.push(args[2]);
    return whyReports[args[2]] ?? [];
  };
  return { run, whyModules };
}

test("checks each allowlisted exception against the why-report of its own module", () => {
  const pnpm = fakePnpm({
    auditReport: auditReportFor(exception, zodException),
    whyReports: { "http-cache-semantics": whyReport, zod: zodWhyReport },
  });
  const accepted = runDependencyAudit({
    allowlist: { schemaVersion: 1, exceptions: [exception, zodException] },
    today: "2026-10-03",
    run: pnpm.run,
  });
  assert.deepEqual(accepted.map((item) => item.advisory), [exception.advisory, zodException.advisory]);
  assert.equal(accepted[1].observedPath, "@paperclipai/shared@0.0.0 -> zod@3.25.76");
  assert.deepEqual(pnpm.whyModules, ["http-cache-semantics", "zod"]);
});

test("runs pnpm why once per allowlisted module and not at all for an empty allowlist", () => {
  const second = { ...zodException, advisory: "GHSA-aaaa-bbbb-cccc" };
  const pnpm = fakePnpm({
    auditReport: auditReportFor(zodException, second),
    whyReports: { zod: zodWhyReport },
  });
  runDependencyAudit({
    allowlist: { schemaVersion: 1, exceptions: [zodException, second] },
    today: "2026-10-03",
    run: pnpm.run,
  });
  assert.deepEqual(pnpm.whyModules, ["zod"]);

  const empty = fakePnpm({ auditReport: { advisories: {} }, whyReports: {} });
  assert.deepEqual(runDependencyAudit({
    allowlist: { schemaVersion: 1, exceptions: [] },
    today: "2026-10-03",
    run: empty.run,
  }), []);
  assert.deepEqual(empty.whyModules, []);
});

test("does not match an exception against another module's why-report", () => {
  assert.throws(() => evaluateAudit({
    auditReport: auditReportFor(zodException),
    whyReports: { zod: whyReport },
    allowlist: { schemaVersion: 1, exceptions: [zodException] },
    today: "2026-10-03",
  }), /GHSA-mrhx-c7xc-m3w5 was not found at the allowlisted dependency path/);
});

test("fails closed when the why-report for an exception's module is missing", () => {
  assert.throws(() => evaluateAudit({
    auditReport: auditReportFor(zodException),
    whyReports: { "http-cache-semantics": whyReport },
    allowlist: { schemaVersion: 1, exceptions: [zodException] },
    today: "2026-10-03",
  }), /pnpm why returned an unsupported report shape for zod/);
});

test("rejects allowlisted module names that are not package names", () => {
  for (const module of ["--registry=https://example.invalid", "", "../zod", "zod --prod"]) {
    assert.throws(() => evaluateAudit({
      auditReport: { advisories: {} },
      whyReports: {},
      allowlist: { schemaVersion: 1, exceptions: [{ ...zodException, module }] },
      today: "2026-10-03",
    }), /must specify a module and valid severity/);
  }
  for (const module of ["@better-auth/core", "better-auth", "JSONStream"]) {
    assert.throws(() => evaluateAudit({
      auditReport: { advisories: {} },
      whyReports: {},
      allowlist: { schemaVersion: 1, exceptions: [{ ...zodException, module }] },
      today: "2026-10-03",
    }), /is allowlisted but was not reported/);
  }
});

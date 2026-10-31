import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const DEFAULT_ALLOWLIST = new URL("../security/dependency-audit-allowlist.json", import.meta.url);
// npm package name, optionally scoped. Allowlisted modules are passed to `pnpm why` as an argument.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

function fail(message) {
  throw new Error(`Dependency audit policy error: ${message}`);
}

function validateAllowlist(document) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.exceptions)) {
    fail("allowlist must use schemaVersion 1 and contain an exceptions array");
  }

  const seen = new Set();
  for (const exception of document.exceptions) {
    if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(exception.advisory ?? "")) {
      fail("every exception must name one valid GHSA advisory");
    }
    if (seen.has(exception.advisory)) fail(`duplicate exception for ${exception.advisory}`);
    seen.add(exception.advisory);
    if (
      typeof exception.module !== "string"
      || !PACKAGE_NAME.test(exception.module)
      || !(exception.severity in SEVERITY_RANK)
    ) {
      fail(`${exception.advisory} must specify a module and valid severity`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.expiresOn ?? "")) {
      fail(`${exception.advisory} must specify expiresOn as YYYY-MM-DD`);
    }
    if (typeof exception.rationale !== "string" || exception.rationale.trim().length < 20) {
      fail(`${exception.advisory} must include a substantive rationale`);
    }
    if (!Array.isArray(exception.dependencyPath) || exception.dependencyPath.length < 2) {
      fail(`${exception.advisory} must include an exact dependencyPath`);
    }
  }
  return document.exceptions;
}

function collectDependencyPaths(whyReport, targetModule) {
  const matches = [];

  function visitDependencies(dependencies, path) {
    for (const [name, detail] of Object.entries(dependencies ?? {})) {
      if (!detail || typeof detail !== "object") continue;
      const segment = `${name}@${detail.version}`;
      const nextPath = [...path, segment];
      if (name === targetModule) matches.push(nextPath);
      visitDependencies(detail.dependencies, nextPath);
      visitDependencies(detail.optionalDependencies, nextPath);
    }
  }

  for (const workspace of whyReport) {
    visitDependencies(workspace.dependencies, []);
    visitDependencies(workspace.optionalDependencies, []);
  }
  return matches;
}

function pathEndsWith(actual, expected) {
  return actual.length >= expected.length && expected.every(
    (segment, index) => actual[actual.length - expected.length + index] === segment,
  );
}

// whyReports maps each allowlisted module name to its `pnpm -r why <module> --json` report.
export function evaluateAudit({ auditReport, whyReports, allowlist, today }) {
  const exceptions = validateAllowlist(allowlist);
  if (!auditReport || typeof auditReport !== "object" || !auditReport.advisories) {
    fail("pnpm audit returned an unsupported report shape");
  }
  if (!whyReports || typeof whyReports !== "object") fail("pnpm why reports must be keyed by module");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail("today must use YYYY-MM-DD");

  const blocking = Object.values(auditReport.advisories).filter(
    (advisory) => SEVERITY_RANK[advisory.severity] >= SEVERITY_RANK.high,
  );
  const accepted = [];

  for (const advisory of blocking) {
    const ghsa = advisory.github_advisory_id;
    const exception = exceptions.find((candidate) => candidate.advisory === ghsa);
    if (!exception) fail(`${ghsa ?? advisory.id} (${advisory.severity}) is not allowlisted`);
    if (today > exception.expiresOn) fail(`${ghsa} expired on ${exception.expiresOn}`);
    if (advisory.module_name !== exception.module || advisory.severity !== exception.severity) {
      fail(`${ghsa} no longer matches its allowlisted module and severity`);
    }

    const whyReport = Object.hasOwn(whyReports, exception.module) ? whyReports[exception.module] : undefined;
    if (!Array.isArray(whyReport)) fail(`pnpm why returned an unsupported report shape for ${exception.module}`);
    const observedPaths = collectDependencyPaths(whyReport, exception.module);
    const matchedPaths = observedPaths.filter((path) => pathEndsWith(path, exception.dependencyPath));
    if (matchedPaths.length === 0) {
      fail(`${ghsa} was not found at the allowlisted dependency path: ${exception.dependencyPath.join(" -> ")}`);
    }
    const unmatchedPath = observedPaths.find((path) => !pathEndsWith(path, exception.dependencyPath));
    if (unmatchedPath) {
      fail(`${ghsa} was found at a non-allowlisted dependency path: ${unmatchedPath.join(" -> ")}`);
    }
    accepted.push({ ...exception, observedPath: exception.dependencyPath.join(" -> ") });
  }

  for (const exception of exceptions) {
    if (!accepted.some((item) => item.advisory === exception.advisory)) {
      fail(`${exception.advisory} is allowlisted but was not reported; remove the stale exception`);
    }
  }
  return accepted;
}

function runJson(command, args) {
  try {
    return JSON.parse(execFileSync(command, args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }));
  } catch (error) {
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout);
      } catch {
        // Fall through to the closed failure below.
      }
    }
    fail(`${command} ${args.join(" ")} did not return valid JSON`);
  }
}

export function runDependencyAudit({ allowlist, today, run = runJson }) {
  const auditReport = run("pnpm", ["audit", "--prod", "--audit-level=high", "--json"]);
  const whyReports = {};
  for (const moduleName of new Set(validateAllowlist(allowlist).map((exception) => exception.module))) {
    whyReports[moduleName] = run("pnpm", ["-r", "why", moduleName, "--prod", "--json"]);
  }
  return evaluateAudit({ auditReport, whyReports, allowlist, today });
}

export function main() {
  const allowlist = JSON.parse(readFileSync(DEFAULT_ALLOWLIST, "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const accepted = runDependencyAudit({ allowlist, today });

  for (const exception of accepted) {
    console.log(`Accepted advisory: ${exception.advisory}`);
    console.log(`Rationale: ${exception.rationale}`);
    console.log(`Expiry: ${exception.expiresOn}`);
    console.log(`Observed dependency path: ${exception.observedPath}`);
  }
  console.log(`Dependency audit passed: ${accepted.length} narrow exception(s); no other high/critical advisories.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

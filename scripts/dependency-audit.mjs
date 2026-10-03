import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const DEFAULT_ALLOWLIST = new URL("../security/dependency-audit-allowlist.json", import.meta.url);

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
    if (typeof exception.module !== "string" || !(exception.severity in SEVERITY_RANK)) {
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

export function evaluateAudit({ auditReport, whyReport, allowlist, today }) {
  const exceptions = validateAllowlist(allowlist);
  if (!auditReport || typeof auditReport !== "object" || !auditReport.advisories) {
    fail("pnpm audit returned an unsupported report shape");
  }
  if (!Array.isArray(whyReport)) fail("pnpm why returned an unsupported report shape");
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

    const observedPaths = collectDependencyPaths(whyReport, exception.module);
    const observedPath = observedPaths.find((path) => pathEndsWith(path, exception.dependencyPath));
    if (!observedPath) {
      fail(`${ghsa} was not found at the allowlisted dependency path: ${exception.dependencyPath.join(" -> ")}`);
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

export function main() {
  const allowlist = JSON.parse(readFileSync(DEFAULT_ALLOWLIST, "utf8"));
  const auditReport = runJson("pnpm", ["audit", "--prod", "--audit-level=high", "--json"]);
  const whyReport = runJson("pnpm", ["-r", "why", "http-cache-semantics", "--prod", "--json"]);
  const today = new Date().toISOString().slice(0, 10);
  const accepted = evaluateAudit({ auditReport, whyReport, allowlist, today });

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

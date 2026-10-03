import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const KNOWN_SEVERITIES = ["info", "low", "moderate", "high", "critical"];

export function evaluateAuditResult({ report, status, signal, processError }) {
  if (processError) throw new Error(`pnpm audit failed to start: ${processError.message}`);
  if (signal) throw new Error(`pnpm audit was terminated by signal ${signal}`);
  if (!Number.isInteger(status) || status < 0 || status > 1) {
    throw new Error(`pnpm audit exited unexpectedly with status ${String(status)}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report) ||
      !report.advisories || typeof report.advisories !== "object" || Array.isArray(report.advisories)) {
    throw new Error("pnpm audit returned an unsupported report shape");
  }

  const counts = report.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object" || KNOWN_SEVERITIES.some(
    (severity) => !Number.isInteger(counts[severity]) || counts[severity] < 0,
  )) {
    throw new Error("pnpm audit returned invalid vulnerability counts");
  }

  const advisories = Object.values(report.advisories);
  if (advisories.some((advisory) => !advisory || typeof advisory !== "object" ||
      !KNOWN_SEVERITIES.includes(advisory.severity) || typeof advisory.module_name !== "string")) {
    throw new Error("pnpm audit returned a malformed advisory record");
  }

  const blocking = advisories.filter((advisory) =>
    BLOCKING_SEVERITIES.has(advisory.severity),
  );
  if (counts.high > 0 || counts.critical > 0 || blocking.length > 0) {
    const summary = blocking.length > 0
      ? blocking.map((advisory) =>
          `${advisory.github_advisory_id ?? advisory.id} ${advisory.module_name}`,
        ).join(", ")
      : "blocking metadata count without advisory records";
    throw new Error(
      `production dependency audit found ${counts.high} high, ${counts.critical} critical; ${summary}`,
    );
  }

  const totalCount = KNOWN_SEVERITIES.reduce((total, severity) => total + counts[severity], 0);
  if ((status === 0 && (totalCount !== 0 || advisories.length !== 0)) ||
      (status === 1 && totalCount === 0 && advisories.length === 0)) {
    throw new Error(`pnpm audit exit status ${status} is inconsistent with its JSON report`);
  }

  return counts;
}

export function main() {
  const result = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`pnpm audit did not return valid JSON: ${result.stderr.trim()}`);
  }

  const counts = evaluateAuditResult({
    report,
    status: result.status,
    signal: result.signal,
    processError: result.error,
  });
  console.log(`Production dependency audit passed: ${counts.high} high, ${counts.critical} critical.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

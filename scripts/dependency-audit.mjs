import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

export function blockingAdvisories(report) {
  if (!report || typeof report !== "object" || !report.advisories) {
    throw new Error("pnpm audit returned an unsupported report shape");
  }
  return Object.values(report.advisories).filter((advisory) =>
    BLOCKING_SEVERITIES.has(advisory.severity),
  );
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

  const blocking = blockingAdvisories(report);
  if (blocking.length > 0) {
    const summary = blocking
      .map((advisory) => `${advisory.github_advisory_id ?? advisory.id} ${advisory.module_name}`)
      .join(", ");
    throw new Error(`production dependency audit found ${blocking.length} high/critical advisories: ${summary}`);
  }

  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(`Production dependency audit passed: ${counts.high ?? 0} high, ${counts.critical ?? 0} critical.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

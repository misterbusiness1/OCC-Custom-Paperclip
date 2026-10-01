#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { classifyDependencyAudit, classifyProtection, gapRecords } from "./classify.mjs";
import { githubApi as gh, listInstalledRepositories } from "./github.mjs";
import { validateInstallationInventory } from "./inventory.mjs";
import { collectDependabotAlerts, mergedReviewRecord } from "./reviews.mjs";
import { collectOccReviewBotRuleset, rulesetDriftMarkdown } from "./rulesets.mjs";
import { dependencyAdvisories } from "./trends.mjs";

const SCHEMA_VERSION = "2.0.0";
const args = parseArgs(process.argv.slice(2));
const observedAt = args.observedAt ?? new Date().toISOString();
const startedAt = new Date().toISOString();

function parseArgs(argv) {
  const result = { output: "fleet-cqe-coverage.v1.json", summary: "fleet-cqe-coverage.md", prLimit: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--output") result.output = argv[++i];
    else if (key === "--summary") result.summary = argv[++i];
    else if (key === "--collector-sha") result.collectorSha = argv[++i];
    else if (key === "--run-issue") result.runIssue = argv[++i];
    else if (key === "--repository-owner") result.repositoryOwner = argv[++i];
    else if (key === "--observed-at") result.observedAt = argv[++i];
    else if (key === "--pr-limit") result.prLimit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!result.collectorSha || !/^[0-9a-f]{40}$/.test(result.collectorSha)) throw new Error("--collector-sha must be a full commit SHA");
  if (!result.runIssue) throw new Error("--run-issue is required");
  if (!result.repositoryOwner || !/^[A-Za-z0-9-]+$/.test(result.repositoryOwner)) throw new Error("--repository-owner is required");
  if (!Number.isInteger(result.prLimit) || result.prLimit < 1 || result.prLimit > 500) throw new Error("--pr-limit must be 1..500");
  return result;
}

function auditExecutable(command) {
  try {
    execFileSync(command, ["audit", "--help"], { encoding: "utf8", stdio: "ignore", timeout: 10_000 });
    return "executable";
  } catch {
    return "unavailable";
  }
}

function dependencyCoverage(repo) {
  const candidates = [
    { path: "composer.lock", command: "composer", evidence: "composer audit --help" },
    { path: "package-lock.json", command: "npm", evidence: "npm audit --help" },
  ];
  let denied = false;
  for (const candidate of candidates) {
    const lock = gh(`/repos/${repo}/contents/${candidate.path}`, { allow: [401, 403, 404] });
    denied ||= lock.status === 401 || lock.status === 403;
    if (lock.status === 200) {
      const auditProbe = auditExecutable(candidate.command);
      const alerts = gh(`/repos/${repo}/vulnerability-alerts`, { allow: [401, 403, 404] });
      return { ...classifyDependencyAudit({ lockStatus: lock.status, auditProbe, alertStatus: alerts.status }), evidence: auditProbe === "executable" ? candidate.evidence : "repository_vulnerability_alerts" };
    }
  }
  const alerts = gh(`/repos/${repo}/vulnerability-alerts`, { allow: [401, 403, 404] });
  return { ...classifyDependencyAudit({ lockStatus: denied ? 403 : 404, auditProbe: "unavailable", alertStatus: alerts.status }), evidence: "repository_vulnerability_alerts" };
}

function advisoryEvidence(repo) {
  const response = collectDependabotAlerts(repo, gh);
  return dependencyAdvisories(response);
}

function protection(repo, branch) {
  const response = gh(`/repos/${repo}/branches/${branch}/protection`, { allow: [403, 404] });
  if (response.status === 200) return classifyProtection(response.data);
  return response.status === 404
    ? { state: "fail", detail: "absent", contexts: [] }
    : { state: "unknown", detail: response.status === 403 ? "denied" : "unavailable", contexts: [] };
}

function mergedReviews(repo) {
  const pulls = gh(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${args.prLimit}`).data ?? [];
  return pulls.filter((pr) => pr.merged_at)
    .map((pr) => mergedReviewRecord(repo, pr, gh))
    .sort((a, b) => a.number - b.number);
}

try {
  const installed = listInstalledRepositories();
  validateInstallationInventory(installed, args.repositoryOwner);
  const rulesetDrift = installed.map((repo) => collectOccReviewBotRuleset(repo.repository, gh));
  const rulesetByRepository = new Map(rulesetDrift.map((result) => [result.repository, result]));

  const repositories = installed.map((repo) => {
    const names = [...new Set([repo.default_branch, "main", "production"])];
    const branches = names.map((name) => {
      const exists = gh(`/repos/${repo.repository}/branches/${name}`, { allow: [403, 404] });
      if (exists.status === 404 && name !== repo.default_branch) return null;
      if (exists.status === 403) return { name, protection: { state: "unknown", detail: "denied", contexts: [] } };
      return { name, protection: protection(repo.repository, name) };
    }).filter(Boolean);
    const record = { ...repo, observed_at: observedAt, branches, occ_review_bot_ruleset: rulesetByRepository.get(repo.repository), merged_pr_reviews: mergedReviews(repo.repository), dependency_coverage: dependencyCoverage(repo.repository), dependency_advisories: advisoryEvidence(repo.repository), collection_errors: [] };
    return { ...record, proposed_owner_assignments: gapRecords(record) };
  });

  const totals = {
    repositories: repositories.length,
    coverage_gaps: repositories.reduce((sum, repo) => sum + repo.proposed_owner_assignments.length, 0),
    unknowns: repositories.reduce((sum, repo) => sum + repo.proposed_owner_assignments.filter((gap) => gap.state === "unknown").length, 0),
    errors: repositories.reduce((sum, repo) => sum + repo.collection_errors.length, 0),
    ruleset_drift: rulesetDrift.filter((result) => result.state !== "pass").length,
  };
  const report = { schema_version: SCHEMA_VERSION, schema_id: "occ-fleet-cqe/2.0.0", collector_sha: args.collectorSha, run_issue: args.runIssue, started_at: startedAt, completed_at: new Date().toISOString(), observed_at: observedAt, installed_repository_count: installed.length, ruleset_drift: rulesetDrift, totals, repositories };
  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = `# Fleet CQE coverage\n\n- Schema: ${SCHEMA_VERSION}\n- Collector SHA: \`${args.collectorSha}\`\n- Run issue: ${args.runIssue}\n- Installed repositories: ${totals.repositories}\n- Coverage gaps: ${totals.coverage_gaps}\n- Unknowns: ${totals.unknowns}\n- Collection errors: ${totals.errors}\n- Ruleset drift: ${totals.ruleset_drift}\n\n${rulesetDriftMarkdown(rulesetDrift)}\nThe JSON artifact is canonical. Findings are report-only proposals; no tasks or repository settings were changed.\n`;
  writeFileSync(args.summary, markdown);
  if (totals.ruleset_drift > 0) {
    console.error(`exact-head OCC Review Bot ruleset drift detected in ${totals.ruleset_drift} repositories`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}

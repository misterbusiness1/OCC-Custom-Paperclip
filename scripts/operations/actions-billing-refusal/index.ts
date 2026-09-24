import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { detectBillingRefusals, isRecoveryExecution } from "./detector.js";
import { incidentBody, migrateState, transitionState } from "./state.js";
import { EMPTY_STATE, type IncidentState, type JobObservation } from "./types.js";

const execFile = promisify(execFileCallback);
const LOOKBACK_MINUTES = 20;

interface GithubRun {
  id: number;
  run_attempt: number;
  name: string;
  updated_at: string;
  pull_requests?: Array<{ number: number }>;
}

interface GithubJob {
  id: number;
  conclusion: string | null;
  started_at: string;
  completed_at: string;
  runner_name: string | null;
  steps?: unknown[];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function gh<T>(path: string): Promise<T> {
  const { stdout } = await execFile("/usr/local/bin/onecli", ["run", "--", "gh", "api", path], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

async function collectLogAvailability(repository: string, jobId: number): Promise<JobObservation["logAvailability"]> {
  try {
    await execFile("/usr/local/bin/onecli", [
      "run", "--", "gh", "api", "--method", "HEAD", "--silent",
      `/repos/${repository}/actions/jobs/${jobId}/logs`,
    ]);
    return "present";
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    return /HTTP 404\b/.test(stderr) ? "absent" : "unavailable";
  }
}

async function collectRepository(repository: string, since: Date): Promise<JobObservation[]> {
  const query = `/repos/${repository}/actions/runs?per_page=100`;
  const { workflow_runs: runs } = await gh<{ workflow_runs: GithubRun[] }>(query);
  const observations: JobObservation[] = [];
  for (const run of runs) {
    if (Date.parse(run.updated_at) < since.getTime()) continue;
    const jobsPath = `/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
    const { jobs } = await gh<{ jobs: GithubJob[] }>(jobsPath);
    for (const job of jobs) {
      let logAvailability: JobObservation["logAvailability"] = "unavailable";
      let annotationAvailability: JobObservation["annotationAvailability"] = "available";
      let annotationMessages: string[] = [];
      const duration = Date.parse(job.completed_at) - Date.parse(job.started_at);
      const structurallyEligible = job.conclusion === "failure"
        && duration >= 0
        && duration <= 30_000
        && (job.steps?.length ?? 0) === 0
        && !job.runner_name?.trim();
      if (structurallyEligible) {
        logAvailability = await collectLogAvailability(repository, job.id);
        try {
          const annotations = await gh<Array<{ message?: string }>>(`/repos/${repository}/check-runs/${job.id}/annotations?per_page=100`);
          annotationMessages = annotations.flatMap((annotation) => annotation.message ? [annotation.message] : []);
        } catch {
          annotationAvailability = "unavailable";
        }
      }
      observations.push({
        repository,
        workflowName: run.name,
        runId: run.id,
        attempt: run.run_attempt,
        jobId: job.id,
        pullRequestNumbers: (run.pull_requests ?? []).map((pullRequest) => pullRequest.number),
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        runnerName: job.runner_name,
        stepCount: job.steps?.length ?? 0,
        logAvailability,
        annotationAvailability,
        annotationMessages,
      });
    }
  }
  return observations;
}

async function readState(path: string): Promise<IncidentState> {
  try {
    return migrateState(JSON.parse(await readFile(path, "utf8")) as Partial<IncidentState>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_STATE };
    throw error;
  }
}

async function writeState(path: string, state: IncidentState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function paperclip(path: string, method: "POST" | "PATCH", body: unknown): Promise<unknown> {
  const base = required("PAPERCLIP_API_URL").replace(/\/$/, "").replace(/\/api$/, "");
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${required("PAPERCLIP_API_KEY")}`,
      "Content-Type": "application/json",
      "X-Paperclip-Run-Id": required("PAPERCLIP_RUN_ID"),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Paperclip ${method} ${path} failed with ${response.status}`);
  return response.json();
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const now = new Date();
  const repositories = required("OCC_ACTIONS_MONITOR_REPOSITORIES").split(",").map((value) => value.trim()).filter(Boolean);
  const statePath = resolve(required("OCC_ACTIONS_MONITOR_STATE_PATH"));
  const observations = (await Promise.all(
    repositories.map((repository) => collectRepository(repository, new Date(now.getTime() - LOOKBACK_MINUTES * 60_000))),
  )).flat();
  const detections = detectBillingRefusals(observations);
  const previous = await readState(statePath);
  const affectedWorkflows = new Set(previous.affectedWorkflows ?? []);
  const recoveryExecutions = observations.filter((observation) => isRecoveryExecution(observation, affectedWorkflows));
  const transition = transitionState(previous, detections, recoveryExecutions, now);

  if (!dryRun && transition.action === "open") {
    const issue = await paperclip(`/companies/${required("PAPERCLIP_COMPANY_ID")}/issues`, "POST", {
      title: "P1: GitHub Actions billing/spend-limit job refusals",
      description: incidentBody(transition.state),
      priority: "high",
      assigneeAgentId: required("OCC_ACTIONS_MONITOR_CTO_AGENT_ID"),
      status: "todo",
    }) as { id: string };
    transition.state.incidentIssueId = issue.id;
  } else if (!dryRun && transition.action === "update" && transition.state.incidentIssueId) {
    await paperclip(`/issues/${transition.state.incidentIssueId}`, "PATCH", {
      description: incidentBody(transition.state),
      priority: "high",
      comment: "Billing-refusal incident updated within the rolling 60-minute deduplication window.",
    });
  } else if (!dryRun && transition.action === "recover" && transition.state.incidentIssueId) {
    await paperclip(`/issues/${transition.state.incidentIssueId}`, "PATCH", {
      status: "done",
      comment: "Recovered after two consecutive clear five-minute windows and a named-runner execution with steps.",
    });
    Object.assign(transition.state, EMPTY_STATE);
  }

  if (!dryRun) await writeState(statePath, transition.state);
  console.log(JSON.stringify({
    dryRun,
    observedJobs: observations.length,
    classifiedJobs: detections.length,
    affectedRepositories: [...new Set(detections.map(({ observation }) => observation.repository))].sort(),
    confidence: [...new Set(detections.map((detection) => detection.confidence))].sort(),
    reasonCategories: [...new Set(detections.map((detection) => detection.reason))].sort(),
    action: transition.action,
    clearWindows: transition.state.clearWindows,
    recoveryExecutionSeen: transition.state.recoveryExecutionSeen,
  }));
}

await main();

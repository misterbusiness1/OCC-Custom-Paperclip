import { EMPTY_STATE, type Detection, type IncidentState, type JobObservation } from "./types.js";

const DEDUP_WINDOW_MS = 60 * 60_000;

export interface StateTransition {
  state: IncidentState;
  action: "none" | "open" | "update" | "recover";
}

export function migrateState(value: Partial<IncidentState>): IncidentState {
  return {
    ...EMPTY_STATE,
    ...value,
    schemaVersion: 2,
    affectedWorkflows: value.affectedWorkflows ?? [],
    affectedRepositories: value.affectedRepositories
      ?? [...new Set((value.affectedWorkflows ?? []).map((workflow) => workflow.split(":", 1)[0]).filter(Boolean))],
    runAttempts: value.runAttempts ?? [],
    pullRequestNumbers: value.pullRequestNumbers ?? [],
    confidences: value.confidences ?? [],
    reasons: value.reasons ?? [],
  };
}

export function incidentBody(state: IncidentState): string {
  const confidence = state.confidences.includes("confirmed") ? "confirmed" : "suspected";
  return [
    "GitHub Actions billing/spend-limit refusal detected.",
    "",
    `- First seen (UTC): ${state.firstSeenAt}`,
    `- Last seen (UTC): ${state.lastSeenAt}`,
    `- Affected repositories: ${state.affectedRepositories.join(", ")}`,
    `- Run/attempt IDs: ${state.runAttempts.join(", ")}`,
    `- Unique PRs (${state.pullRequestNumbers.length}): ${state.pullRequestNumbers.length ? state.pullRequestNumbers.join(", ") : "none"}`,
    `- Confidence: ${confidence}`,
    `- Sanitized reason category: ${state.reasons.join(", ")}`,
    "",
    "Triage: this signature means GitHub produced no job log, assigned no runner, and executed no repository steps; it is not a repository CI failure.",
  ].join("\n");
}

export function transitionState(
  previous: IncidentState,
  detections: Detection[],
  recoveryExecutions: JobObservation[],
  now: Date,
): StateTransition {
  const nowIso = now.toISOString();
  if (detections.length > 0) {
    const withinWindow = previous.windowStartedAt !== null
      && now.getTime() - Date.parse(previous.windowStartedAt) < DEDUP_WINDOW_MS;
    const currentWorkflows = detections.map(({ observation }) => `${observation.repository}:${observation.workflowName}`);
    const currentRepositories = detections.map(({ observation }) => observation.repository);
    const currentRunAttempts = detections.map(({ observation }) => `${observation.repository} ${observation.runId}/${observation.attempt}`);
    const currentPullRequests = detections.flatMap(({ observation }) => observation.pullRequestNumbers);
    const currentConfidences = detections.map(({ confidence }) => confidence);
    const currentReasons = detections.map(({ reason }) => reason);
    const prior = withinWindow ? migrateState(previous) : EMPTY_STATE;
    return {
      action: withinWindow && previous.incidentIssueId ? "update" : "open",
      state: {
        ...previous,
        windowStartedAt: withinWindow ? previous.windowStartedAt : nowIso,
        incidentIssueId: withinWindow ? previous.incidentIssueId : null,
        firstSeenAt: withinWindow && previous.firstSeenAt ? previous.firstSeenAt : nowIso,
        lastSeenAt: nowIso,
        clearWindows: 0,
        recoveryExecutionSeen: false,
        affectedWorkflows: [...new Set([...prior.affectedWorkflows, ...currentWorkflows])].sort(),
        affectedRepositories: [...new Set([...prior.affectedRepositories, ...currentRepositories])].sort(),
        runAttempts: [...new Set([...prior.runAttempts, ...currentRunAttempts])].sort(),
        pullRequestNumbers: [...new Set([...prior.pullRequestNumbers, ...currentPullRequests])].sort((a, b) => a - b),
        confidences: [...new Set([...prior.confidences, ...currentConfidences])].sort(),
        reasons: [...new Set([...prior.reasons, ...currentReasons])].sort(),
      },
    };
  }

  if (!previous.incidentIssueId) return { state: previous, action: "none" };
  const recoverySeen = previous.recoveryExecutionSeen || recoveryExecutions.length > 0;
  const clearWindows = previous.clearWindows + 1;
  if (clearWindows >= 2 && recoverySeen) {
    return { state: { ...previous, clearWindows, recoveryExecutionSeen: true }, action: "recover" };
  }
  return {
    state: { ...previous, clearWindows, recoveryExecutionSeen: recoverySeen },
    action: "none",
  };
}

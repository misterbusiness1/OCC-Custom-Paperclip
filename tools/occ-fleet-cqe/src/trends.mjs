import { REVIEW_BOT, REVIEW_GATE_NAMES } from "./classify.mjs";

const UNKNOWN = new Set([401, 403]);

function evidenceState(status) {
  if (UNKNOWN.has(status)) return "denied";
  if (status === 404) return "unsupported";
  return "unavailable";
}

function durationSeconds(from, to) {
  const value = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function qualifyingReview(reviews, headSha) {
  return reviews
    .filter((review) => review?.user?.login?.toLowerCase() === REVIEW_BOT.toLowerCase())
    .filter((review) => review.commit_id === headSha && review.submitted_at)
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))[0];
}

function qualifyingCheck(checks) {
  return checks
    .filter((check) => REVIEW_GATE_NAMES.has(check.name))
    .filter((check) => check.status === "completed" && check.completed_at)
    .sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at))[0];
}

export function reviewLatency(repo, pr, reviewsResult, checksResult) {
  const base = {
    repository: repo,
    number: pr.number,
    created_at: pr.created_at ?? null,
    head_sha: pr.head.sha,
    first_cqe_at: null,
    latency_seconds: null,
    evidence_status: "missing",
    evidence_kind: null,
  };
  const incomplete = [reviewsResult, checksResult].find((result) => result.status !== 200 || result.state !== "complete");
  if (incomplete) return { ...base, evidence_status: evidenceState(incomplete.status) };
  const review = qualifyingReview(reviewsResult.data, pr.head.sha);
  const check = qualifyingCheck(checksResult.data.check_runs);
  const candidates = [
    review && { at: review.submitted_at, kind: "review", url: review.html_url ?? pr.html_url },
    check && { at: check.completed_at, kind: "check", url: check.html_url ?? pr.html_url },
  ].filter(Boolean).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (candidates.length === 0) {
    return base;
  }
  const first = candidates[0];
  const latency = durationSeconds(pr.created_at, first.at);
  if (latency === null) return { ...base, evidence_status: "unavailable" };
  return { ...base, first_cqe_at: first.at, latency_seconds: latency, evidence_status: "measured", evidence_kind: first.kind, evidence: first.url };
}

function toolName(check) {
  const name = String(check.name ?? "").toLowerCase();
  if (name.includes("phpstan")) return "phpstan";
  if (name.includes("phpcs") || name.includes("code sniffer")) return "phpcs";
  return null;
}

function baselineDelta(check) {
  const text = `${check.output?.title ?? ""}\n${check.output?.summary ?? ""}\n${check.output?.text ?? ""}`;
  const match = text.match(/baseline(?:\s+error)?s?\s*(?:delta|change|movement)?\s*[:=]\s*([+-]?\d+)/i);
  return match ? Number(match[1]) : null;
}

export function staticAnalysisEvidence(checksResult, annotationsByCheck, changedFilesResult) {
  const empty = (status) => ({ evidence_status: status, error_delta: null, baseline_delta: null, changed_file_errors: null, check_count: 0 });
  if (checksResult.status !== 200) {
    const state = evidenceState(checksResult.status);
    return { phpstan: empty(state), phpcs: empty(state) };
  }
  if (changedFilesResult.status !== 200) {
    const state = evidenceState(changedFilesResult.status);
    return { phpstan: empty(state), phpcs: empty(state) };
  }
  const changed = new Set((changedFilesResult.data ?? []).map((file) => file.filename));
  const result = { phpstan: empty("missing"), phpcs: empty("missing") };
  const grouped = { phpstan: [], phpcs: [] };
  for (const check of checksResult.data?.check_runs ?? []) {
    const tool = toolName(check);
    if (tool) grouped[tool].push(check);
  }
  for (const [tool, checks] of Object.entries(grouped)) {
    if (checks.length === 0) continue;
    const annotations = checks.map((check) => annotationsByCheck.get(check.id));
    const incomplete = annotations.find((entry) => !entry || entry.status !== 200);
    if (incomplete) {
      result[tool] = { ...empty(evidenceState(incomplete?.status ?? 0)), check_count: checks.length };
      continue;
    }
    const errors = annotations.reduce((sum, entry) => sum + (entry.data ?? [])
      .filter((item) => changed.has(item.path) && ["failure", "warning"].includes(item.annotation_level)).length, 0);
    const baselines = checks.map(baselineDelta);
    const evidenceUrls = checks.map((check) => check.html_url).filter(Boolean).sort();
    result[tool] = {
      evidence_status: "measured",
      error_delta: errors,
      changed_file_errors: errors,
      baseline_delta: baselines.every((value) => value !== null) ? baselines.reduce((sum, value) => sum + value, 0) : null,
      check_count: checks.length,
      evidence: evidenceUrls[0] ?? null,
      evidence_urls: evidenceUrls,
    };
  }
  return result;
}

export function dependencyAdvisories(response) {
  if (response.status !== 200) {
    return { evidence_status: evidenceState(response.status), actionable_count: null, severity: null };
  }
  const alerts = (response.data ?? []).filter((alert) => alert.state === "open" && !alert.dismissed_at);
  const severity = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  for (const alert of alerts) {
    const key = String(alert.security_advisory?.severity ?? "unknown").toLowerCase();
    severity[key in severity ? key : "unknown"] += 1;
  }
  return { evidence_status: "measured", actionable_count: alerts.length, severity };
}

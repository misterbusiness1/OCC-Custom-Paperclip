import { classifyBotReview } from "./classify.mjs";
import { reviewLatency, staticAnalysisEvidence } from "./trends.mjs";

export const REVIEW_PAGE_SIZE = 100;
export const REVIEW_PAGE_LIMIT = 5;

export function collectPagedEvidence(endpoint, gh, { pageLimit = REVIEW_PAGE_LIMIT, select = (data) => data ?? [] } = {}) {
  const items = [];
  for (let page = 1; page <= pageLimit; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = gh(`${endpoint}${separator}per_page=${REVIEW_PAGE_SIZE}&page=${page}`, {
      allow: [401, 403, 404],
    });
    if (response.status !== 200) return { state: "unknown", status: response.status, data: [] };
    const batch = select(response.data);
    if (!Array.isArray(batch)) return { state: "unknown", status: 0, data: [] };
    items.push(...batch);
    if (batch.length < REVIEW_PAGE_SIZE) return { state: "complete", status: 200, data: items };
  }
  return { state: "bounded", status: 0, data: [] };
}

export function collectPullReviews(repo, number, gh, options) {
  const result = collectPagedEvidence(`/repos/${repo}/pulls/${number}/reviews`, gh, options);
  return { ...result, reviews: result.data };
}

export function collectDependabotAlerts(repo, gh, options) {
  return collectPagedEvidence(`/repos/${repo}/dependabot/alerts?state=open`, gh, options);
}

export function collectCheckRuns(repo, sha, gh, options) {
  const result = collectPagedEvidence(`/repos/${repo}/commits/${sha}/check-runs`, gh, {
    ...options,
    select: (data) => data?.check_runs,
  });
  return { ...result, data: result.status === 200 ? { check_runs: result.data } : null };
}

export function collectChangedFiles(repo, number, gh, options) {
  return collectPagedEvidence(`/repos/${repo}/pulls/${number}/files`, gh, options);
}

export function collectCheckAnnotations(repo, checkId, gh, options) {
  return collectPagedEvidence(`/repos/${repo}/check-runs/${checkId}/annotations`, gh, options);
}

export function mergedReviewRecord(repo, pr, gh, options) {
  const result = collectPullReviews(repo, pr.number, gh, options);
  const checks = collectCheckRuns(repo, pr.head.sha, gh, options);
  const files = collectChangedFiles(repo, pr.number, gh, options);
  const annotations = new Map();
  if (checks.status === 200) {
    for (const check of checks.data?.check_runs ?? []) {
      if (/phpstan|phpcs|code sniffer/i.test(check.name ?? "")) {
        annotations.set(check.id, collectCheckAnnotations(repo, check.id, gh, options));
      }
    }
  }
  const reviewsEvidence = { state: result.state, status: result.status, data: result.state === "complete" ? result.reviews : [] };
  return {
    number: pr.number,
    head_sha: pr.head.sha,
    merged_at: pr.merged_at,
    review_state: result.state === "complete"
      ? classifyBotReview(pr.head.sha, result.reviews)
      : "unknown",
    review_collection: result.state,
    evidence: pr.html_url,
    cqe_latency: reviewLatency(repo, pr, reviewsEvidence, checks),
    static_analysis: staticAnalysisEvidence(checks, annotations, files),
  };
}

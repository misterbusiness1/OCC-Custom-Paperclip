export const REVIEW_BOT = "occ-review-bot[bot]";
export const REVIEW_GATE_NAMES = new Set(["OCC Review Bot", "CQE"]);

export function classifyBotReview(headSha, reviews, bot = REVIEW_BOT) {
  const botReviews = reviews.filter(
    (review) => review?.user?.login?.toLowerCase() === bot.toLowerCase(),
  );
  if (botReviews.some((review) => review.state === "APPROVED" && review.commit_id === headSha)) {
    return "approved";
  }
  if (botReviews.some((review) => review.commit_id === headSha)) return "non_approve";
  if (botReviews.some((review) => review.state === "APPROVED")) return "stale_head";
  if (botReviews.length > 0) return "non_approve";
  return "missing";
}

export function classifyAlertAccess(status) {
  if (status === 204) return { state: "pass", detail: "enabled" };
  if (status === 404) return { state: "unknown", detail: "disabled_or_unavailable" };
  if (status === 401 || status === 403) return { state: "unknown", detail: "denied" };
  return { state: "unknown", detail: `http_${status}` };
}

export function classifyDependencyAudit({ lockStatus, auditProbe, alertStatus }) {
  if (lockStatus === 200 && auditProbe === "executable") {
    return { state: "pass", detail: "audit_executable" };
  }
  if (alertStatus === 204) return { state: "pass", detail: "alerts_enabled" };
  if (lockStatus === 401 || lockStatus === 403 || alertStatus === 401 || alertStatus === 403) {
    return { state: "unknown", detail: "denied" };
  }
  if (lockStatus === 200 && auditProbe === "unavailable") {
    return { state: "unknown", detail: "audit_unavailable" };
  }
  return classifyAlertAccess(alertStatus);
}

export function classifyProtection(payload) {
  const checks = [
    ...(payload?.required_status_checks?.contexts ?? []),
    ...(payload?.required_status_checks?.checks ?? []).map((check) => check.context),
  ];
  return checks.some((name) => REVIEW_GATE_NAMES.has(name))
    ? { state: "pass", detail: "required", contexts: [...new Set(checks)].sort() }
    : { state: "fail", detail: "absent", contexts: [...new Set(checks)].sort() };
}

export function gapRecords(repository) {
  const gaps = [];
  const add = (kind, subject, state, detail) => gaps.push({
    key: `${repository.repository}:${kind}:${subject}`,
    repository: repository.repository,
    owner: repository.owner,
    kind,
    subject,
    state,
    detail,
    action: "proposed_only",
  });
  for (const branch of repository.branches) {
    if (branch.protection.state !== "pass") {
      add("branch_protection", branch.name, branch.protection.state, branch.protection.detail);
    }
  }
  for (const pr of repository.merged_pr_reviews) {
    if (pr.review_state !== "approved") add("merged_pr_review", String(pr.number), "fail", pr.review_state);
  }
  if (repository.dependency_coverage.state !== "pass") {
    add("dependency_audit", "repository", repository.dependency_coverage.state, repository.dependency_coverage.detail);
  }
  return gaps.sort((a, b) => a.key.localeCompare(b.key));
}

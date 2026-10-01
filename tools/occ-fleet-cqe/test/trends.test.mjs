import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dependencyAdvisories, reviewLatency, staticAnalysisEvidence } from "../src/trends.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/complete.json", import.meta.url)));
const incomplete = JSON.parse(readFileSync(new URL("./fixtures/incomplete.json", import.meta.url)));

test("complete fixtures produce exact-head latency and measured static-analysis/advisory values", () => {
  const latency = reviewLatency("acme/widget", fixture.pr, { state: "complete", status: 200, data: fixture.reviews }, { state: "complete", status: 200, data: fixture.checks });
  assert.deepEqual(latency, {
    repository: "acme/widget", number: 42, created_at: fixture.pr.created_at, head_sha: "abc",
    first_cqe_at: "2026-09-01T10:20:00Z", latency_seconds: 1200, evidence_status: "measured",
    evidence_kind: "check", evidence: "https://example.test/cqe",
  });
  const annotations = new Map(Object.entries(fixture.annotations).map(([id, data]) => [Number(id), { status: 200, data }]));
  const staticEvidence = staticAnalysisEvidence({ status: 200, data: fixture.checks }, annotations, { status: 200, data: fixture.files });
  assert.equal(staticEvidence.phpstan.evidence_status, "measured");
  assert.equal(staticEvidence.phpstan.changed_file_errors, 1);
  assert.equal(staticEvidence.phpstan.baseline_delta, -2);
  assert.equal(staticEvidence.phpcs.evidence_status, "measured");
  assert.equal(staticEvidence.phpcs.changed_file_errors, 0);
  const advisories = dependencyAdvisories({ status: 200, data: fixture.alerts });
  assert.equal(advisories.evidence_status, "measured");
  assert.equal(advisories.actionable_count, 2);
  assert.equal(advisories.severity.high, 1);
});

test("denied evidence is explicit for every new lane", () => {
  assert.equal(reviewLatency("acme/widget", fixture.pr, { state: "unknown", status: 403 }, { state: "unknown", status: 403 }).evidence_status, "denied");
  const staticEvidence = staticAnalysisEvidence({ status: 403 }, new Map(), { status: 200, data: fixture.files });
  assert.equal(staticEvidence.phpstan.evidence_status, "denied");
  assert.equal(staticEvidence.phpcs.evidence_status, "denied");
  assert.equal(dependencyAdvisories({ status: 403 }).evidence_status, "denied");
});

test("missing evidence is never treated as a measured zero by Monday trend reducers", () => {
  const latency = reviewLatency("acme/widget", fixture.pr, { state: "complete", status: 200, data: [] }, { state: "complete", status: 200, data: { check_runs: [] } });
  const staticEvidence = staticAnalysisEvidence({ status: 200, data: { check_runs: [] } }, new Map(), { status: 200, data: fixture.files });
  assert.equal(latency.evidence_status, "missing");
  assert.equal(latency.latency_seconds, null);
  assert.equal(staticEvidence.phpstan.evidence_status, "missing");
  assert.equal(staticEvidence.phpstan.changed_file_errors, null);
  assert.equal(staticEvidence.phpcs.evidence_status, "missing");
  assert.equal(dependencyAdvisories({ status: 404 }).evidence_status, "unsupported");

  const values = [
    { evidence_status: "measured", changed_file_errors: 0 },
    staticEvidence.phpstan,
    { evidence_status: "denied", changed_file_errors: null },
  ].filter((item) => item.evidence_status === "measured").map((item) => item.changed_file_errors);
  assert.deepEqual(values, [0]);
});

test("latency is non-measured unless both candidate feeds are complete", () => {
  const validReview = { state: "complete", status: 200, data: fixture.reviews };
  const validCheck = { state: "complete", status: 200, data: fixture.checks };
  const cases = [
    [incomplete.bounded_reviews, validCheck],
    [validReview, incomplete.bounded_checks],
    [{ state: "unknown", status: 403, data: [] }, validCheck],
    [validReview, { state: "unknown", status: 403, data: null }],
    [{ state: "unknown", status: 0, data: [] }, validCheck],
    [validReview, { state: "unknown", status: 0, data: null }],
  ];
  for (const [reviews, checks] of cases) {
    const latency = reviewLatency("acme/widget", fixture.pr, reviews, checks);
    assert.notEqual(latency.evidence_status, "measured");
    assert.equal(latency.first_cqe_at, null);
    assert.equal(latency.latency_seconds, null);
  }
});

test("multiple checks for one tool aggregate deterministically", () => {
  const checks = { status: 200, data: { check_runs: [
    { id: 10, name: "PHPStan app", html_url: "https://example.test/z", output: { summary: "baseline delta: -2" } },
    { id: 11, name: "PHPStan plugin", html_url: "https://example.test/a", output: { summary: "baseline delta: +1" } },
  ] } };
  const annotations = new Map([
    [10, { status: 200, data: [{ path: "changed.php", annotation_level: "failure" }] }],
    [11, { status: 200, data: [
      { path: "changed.php", annotation_level: "failure" },
      { path: "changed.php", annotation_level: "warning" },
    ] }],
  ]);
  const evidence = staticAnalysisEvidence(checks, annotations, { status: 200, data: [{ filename: "changed.php" }] }).phpstan;
  assert.deepEqual(evidence, {
    evidence_status: "measured", error_delta: 3, changed_file_errors: 3, baseline_delta: -1,
    check_count: 2, evidence: "https://example.test/a",
    evidence_urls: ["https://example.test/a", "https://example.test/z"],
  });
});

test("one incomplete same-tool check makes the aggregate non-measured", () => {
  const checks = { status: 200, data: { check_runs: [
    { id: 10, name: "PHPStan app" }, { id: 11, name: "PHPStan plugin" },
  ] } };
  const annotations = new Map([[10, { status: 200, data: [] }], [11, { status: 403 }]]);
  const evidence = staticAnalysisEvidence(checks, annotations, { status: 200, data: [] }).phpstan;
  assert.equal(evidence.evidence_status, "denied");
  assert.equal(evidence.changed_file_errors, null);
  assert.equal(evidence.check_count, 2);
});

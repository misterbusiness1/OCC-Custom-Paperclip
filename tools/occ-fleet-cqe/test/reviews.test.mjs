import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  collectChangedFiles,
  collectCheckAnnotations,
  collectCheckRuns,
  collectDependabotAlerts,
  collectPullReviews,
  mergedReviewRecord,
  REVIEW_PAGE_SIZE,
} from "../src/reviews.mjs";

const review = (id) => ({ id, state: "COMMENTED", commit_id: "head", user: { login: "someone" } });
const incomplete = JSON.parse(readFileSync(new URL("./fixtures/incomplete.json", import.meta.url)));

test("review retrieval continues beyond GitHub's default 30 records", () => {
  const endpoints = [];
  const gh = (endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.includes("/check-runs")) return { status: 200, data: { check_runs: [] } };
    if (endpoint.includes("/files")) return { status: 200, data: [] };
    return { status: 200, data: endpoints.length === 1
      ? Array.from({ length: REVIEW_PAGE_SIZE }, (_, index) => review(index + 1))
      : [review(REVIEW_PAGE_SIZE + 1)] };
  };
  const result = collectPullReviews("acme/widget", 7, gh);
  assert.equal(result.state, "complete");
  assert.equal(result.reviews.length, REVIEW_PAGE_SIZE + 1);
  assert.deepEqual(endpoints, [
    "/repos/acme/widget/pulls/7/reviews?per_page=100&page=1",
    "/repos/acme/widget/pulls/7/reviews?per_page=100&page=2",
  ]);
});

const pageNumber = (endpoint) => Number(new URL(endpoint, "https://example.test").searchParams.get("page"));
const pagedGh = (makeItem, wrap = (items) => items) => (endpoint) => {
  const page = pageNumber(endpoint);
  const count = page === 1 ? REVIEW_PAGE_SIZE : 7;
  return { status: 200, data: wrap(Array.from({ length: count }, (_, index) => makeItem((page - 1) * REVIEW_PAGE_SIZE + index + 1))) };
};

test("every trend evidence lane retrieves more than 100 records completely", () => {
  assert.equal(collectDependabotAlerts("acme/widget", pagedGh((id) => ({ id }))).data.length, 107);
  assert.equal(collectChangedFiles("acme/widget", 7, pagedGh((id) => ({ filename: `file-${id}.php` }))).data.length, 107);
  assert.equal(collectCheckRuns("acme/widget", "head", pagedGh((id) => ({ id }), (items) => ({ check_runs: items }))).data.check_runs.length, 107);
  assert.equal(collectCheckAnnotations("acme/widget", 11, pagedGh((id) => ({ id }))).data.length, 107);
});

test("check-run retrieval rejects malformed HTTP-200 payloads", () => {
  for (const data of incomplete.malformed_check_payloads) {
    const result = collectCheckRuns("acme/widget", "head", () => ({ status: 200, data }));
    assert.deepEqual({ state: result.state, status: result.status, data: result.data }, {
      state: "unknown", status: 0, data: null,
    });
  }
});

test("every trend evidence lane preserves denied and bounded semantics", () => {
  const denied = () => ({ status: 403, data: null });
  const full = (_endpoint) => ({ status: 200, data: Array.from({ length: REVIEW_PAGE_SIZE }, (_, id) => ({ id })) });
  const fullChecks = (_endpoint) => ({ status: 200, data: { check_runs: Array.from({ length: REVIEW_PAGE_SIZE }, (_, id) => ({ id })) } });
  for (const result of [
    collectDependabotAlerts("acme/widget", denied),
    collectChangedFiles("acme/widget", 7, denied),
    collectCheckRuns("acme/widget", "head", denied),
    collectCheckAnnotations("acme/widget", 11, denied),
  ]) assert.deepEqual({ state: result.state, status: result.status }, { state: "unknown", status: 403 });
  const bounded = [
    collectDependabotAlerts("acme/widget", full, { pageLimit: 2 }),
    collectChangedFiles("acme/widget", 7, full, { pageLimit: 2 }),
    collectCheckRuns("acme/widget", "head", fullChecks, { pageLimit: 2 }),
    collectCheckAnnotations("acme/widget", 11, full, { pageLimit: 2 }),
  ];
  for (const result of bounded) {
    assert.equal(result.state, "bounded");
    assert.equal(result.status, 0);
    assert.equal(result.data === null || result.data.length === 0, true);
  }
});

test("review retrieval is bounded and never reports truncated evidence as clean", () => {
  let calls = 0;
  const gh = (endpoint) => {
    calls += 1;
    if (endpoint.includes("/check-runs")) return { status: 200, data: { check_runs: [] } };
    if (endpoint.includes("/files")) return { status: 200, data: [] };
    return { status: 200, data: Array.from({ length: REVIEW_PAGE_SIZE }, (_, index) => review(index + 1)) };
  };
  const pr = { number: 9, head: { sha: "head" }, merged_at: "2026-09-07T00:00:00Z", html_url: "https://example.test/pr/9" };
  const record = mergedReviewRecord("acme/widget", pr, gh, { pageLimit: 2 });
  assert.equal(calls, 4);
  assert.equal(record.review_collection, "bounded");
  assert.equal(record.review_state, "unknown");
});

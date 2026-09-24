import assert from "node:assert/strict";
import test from "node:test";
import { classifyAlertAccess, classifyBotReview, classifyDependencyAudit, classifyProtection, gapRecords } from "../src/classify.mjs";

const bot = (state, commit_id) => ({ state, commit_id, user: { login: "occ-review-bot[bot]" } });

test("classifies exact-head approval", () => assert.equal(classifyBotReview("head", [bot("APPROVED", "head")]), "approved"));
test("classifies stale-head approval", () => assert.equal(classifyBotReview("head", [bot("APPROVED", "old")]), "stale_head"));
test("classifies missing bot review", () => assert.equal(classifyBotReview("head", []), "missing"));
test("classifies non-approve bot review", () => assert.equal(classifyBotReview("head", [bot("COMMENTED", "head")]), "non_approve"));
test("current-head non-approve takes precedence over stale approval", () => {
  assert.equal(classifyBotReview("head", [bot("APPROVED", "old"), bot("CHANGES_REQUESTED", "head")]), "non_approve");
});
test("alert disabled/unavailable is unknown, never clean", () => assert.deepEqual(classifyAlertAccess(404), { state: "unknown", detail: "disabled_or_unavailable" }));
test("alert denied is unknown, never clean", () => assert.deepEqual(classifyAlertAccess(403), { state: "unknown", detail: "denied" }));
test("executable audit capability passes only with a lockfile", () => assert.deepEqual(classifyDependencyAudit({ lockStatus: 200, auditProbe: "executable", alertStatus: 404 }), { state: "pass", detail: "audit_executable" }));
test("unavailable audit tooling is unknown when alerts are unavailable", () => assert.deepEqual(classifyDependencyAudit({ lockStatus: 200, auditProbe: "unavailable", alertStatus: 404 }), { state: "unknown", detail: "audit_unavailable" }));
test("denied audit evidence is unknown", () => assert.deepEqual(classifyDependencyAudit({ lockStatus: 403, auditProbe: "unavailable", alertStatus: 403 }), { state: "unknown", detail: "denied" }));
test("enabled alerts pass even without executable local audit tooling", () => assert.deepEqual(classifyDependencyAudit({ lockStatus: 200, auditProbe: "unavailable", alertStatus: 204 }), { state: "pass", detail: "alerts_enabled" }));
test("recognizes the required gate and detects absence", () => {
  assert.equal(classifyProtection({ required_status_checks: { contexts: ["OCC Review Bot"] } }).state, "pass");
  assert.equal(classifyProtection({ required_status_checks: { contexts: ["build"] } }).state, "fail");
});
test("gap keys are deterministic and deduplicable", () => {
  const repo = { repository: "acme/widget", owner: "acme", branches: [{ name: "main", protection: { state: "fail", detail: "absent" } }], merged_pr_reviews: [], dependency_coverage: { state: "pass", detail: "enabled" } };
  assert.deepEqual(gapRecords(repo).map((gap) => gap.key), ["acme/widget:branch_protection:main"]);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXPECTED_REPOSITORIES } from "../src/inventory.mjs";
import { collectOccReviewBotRuleset, rulesetDriftMarkdown, validateOccReviewBotRuleset } from "../src/rulesets.mjs";

const fixture = JSON.parse(readFileSync(new URL("fixtures/rulesets.json", import.meta.url), "utf8"));

function clone(value) {
  return structuredClone(value);
}

test("passes the exact governed ruleset for all 45 manifest repositories", () => {
  assert.equal(EXPECTED_REPOSITORIES.length, 45);
  const results = EXPECTED_REPOSITORIES.map((repository) => validateOccReviewBotRuleset(repository, [clone(fixture.compliant)]));
  assert.equal(results.filter((result) => result.state === "pass").length, 45);
  assert.match(rulesetDriftMarkdown(results), /Repositories checked: 45/);
  assert.match(rulesetDriftMarkdown(results), /Result: PASS/);
});

test("fails closed with a named missing-rule delta", () => {
  const result = validateOccReviewBotRuleset("misterbusiness1/missing", []);
  assert.equal(result.state, "fail");
  assert.deepEqual(result.deltas, [{ field: "matching_ruleset_count", expected: 1, actual: 0 }]);
});

test("reports an altered integration id", () => {
  const ruleset = clone(fixture.compliant);
  ruleset.rules[0].parameters.required_status_checks[0].integration_id = fixture.altered_integration;
  const result = validateOccReviewBotRuleset("misterbusiness1/altered", [ruleset]);
  assert.deepEqual(result.deltas, [{ field: "rules.required_status_checks.integration_id", expected: 3604655, actual: 999999 }]);
});

test("reports a bypass actor", () => {
  const ruleset = clone(fixture.compliant);
  ruleset.bypass_actors = [fixture.bypass_actor];
  const result = validateOccReviewBotRuleset("misterbusiness1/bypass", [ruleset]);
  assert.equal(result.deltas[0].field, "bypass_actors");
});

test("reports disabled enforcement", () => {
  const ruleset = clone(fixture.compliant);
  ruleset.enforcement = fixture.disabled_enforcement;
  const result = validateOccReviewBotRuleset("misterbusiness1/disabled", [ruleset]);
  assert.deepEqual(result.deltas, [{ field: "enforcement", expected: "active", actual: "disabled" }]);
});

test("fails closed when the ruleset excludes a branch", () => {
  const ruleset = clone(fixture.compliant);
  ruleset.conditions.ref_name.exclude = ["refs/heads/master"];
  const result = validateOccReviewBotRuleset("misterbusiness1/excluded", [ruleset]);
  assert.equal(result.state, "fail");
  assert.deepEqual(result.deltas, [
    { field: "conditions.ref_name.exclude", expected: [], actual: ["refs/heads/master"] },
  ]);
});

test("reads effective rulesets and exact detail without mutation", () => {
  const calls = [];
  const api = (endpoint) => {
    calls.push(endpoint);
    return endpoint.includes("/24119098?")
      ? { status: 200, data: clone(fixture.compliant) }
      : { status: 200, data: [{ id: 24119098, name: "Require exact-head OCC Review Bot" }] };
  };
  assert.equal(collectOccReviewBotRuleset("misterbusiness1/My-Tobacco-Vault", api).state, "pass");
  assert.deepEqual(calls, [
    "/repos/misterbusiness1/My-Tobacco-Vault/rulesets?includes_parents=true",
    "/repos/misterbusiness1/My-Tobacco-Vault/rulesets/24119098?includes_parents=true",
  ]);
});

test("Markdown includes repository names and field-level deltas", () => {
  const markdown = rulesetDriftMarkdown([validateOccReviewBotRuleset("misterbusiness1/missing", [])]);
  assert.match(markdown, /misterbusiness1\/missing/);
  assert.match(markdown, /matching_ruleset_count/);
  assert.match(markdown, /Result: FAIL/);
});

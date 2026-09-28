export const REQUIRED_RULESET_NAME = "Require exact-head OCC Review Bot";
export const REQUIRED_INTEGRATION_ID = 3604655;

function delta(field, expected, actual) {
  return { field, expected, actual };
}

function requiredStatusChecksRule(ruleset) {
  return (ruleset.rules ?? []).filter((rule) => rule.type === "required_status_checks");
}

export function validateOccReviewBotRuleset(repository, effectiveRulesets) {
  const matches = effectiveRulesets.filter((ruleset) => ruleset.name === REQUIRED_RULESET_NAME);
  const deltas = [];

  if (matches.length !== 1) {
    deltas.push(delta("matching_ruleset_count", 1, matches.length));
  }

  if (matches.length === 1) {
    const ruleset = matches[0];
    const statusRules = requiredStatusChecksRule(ruleset);
    const parameters = statusRules[0]?.parameters ?? {};
    const checks = parameters.required_status_checks ?? [];
    const occChecks = checks.filter((check) => check.context === "OCC Review Bot");

    if (ruleset.target !== "branch") deltas.push(delta("target", "branch", ruleset.target ?? null));
    if (ruleset.enforcement !== "active") deltas.push(delta("enforcement", "active", ruleset.enforcement ?? null));
    if ((ruleset.bypass_actors ?? []).length !== 0) deltas.push(delta("bypass_actors", [], ruleset.bypass_actors));

    const includes = ruleset.conditions?.ref_name?.include ?? [];
    if (includes.length !== 1 || includes[0] !== "~DEFAULT_BRANCH") {
      deltas.push(delta("conditions.ref_name.include", ["~DEFAULT_BRANCH"], includes));
    }

    if (statusRules.length !== 1) {
      deltas.push(delta("rules.required_status_checks.count", 1, statusRules.length));
    }
    if (occChecks.length !== 1) {
      deltas.push(delta("rules.required_status_checks.context_count", 1, occChecks.length));
    } else if (occChecks[0].integration_id !== REQUIRED_INTEGRATION_ID) {
      deltas.push(delta("rules.required_status_checks.integration_id", REQUIRED_INTEGRATION_ID, occChecks[0].integration_id ?? null));
    }
    if (checks.length !== 1) {
      deltas.push(delta("rules.required_status_checks.check_count", 1, checks.length));
    }
    if (parameters.strict_required_status_checks_policy !== true) {
      deltas.push(delta("rules.required_status_checks.strict_required_status_checks_policy", true, parameters.strict_required_status_checks_policy ?? null));
    }
    if (parameters.do_not_enforce_on_create !== false) {
      deltas.push(delta("rules.required_status_checks.do_not_enforce_on_create", false, parameters.do_not_enforce_on_create ?? null));
    }
  }

  return {
    repository,
    state: deltas.length === 0 ? "pass" : "fail",
    ruleset_id: matches.length === 1 ? matches[0].id ?? null : null,
    deltas,
  };
}

export function collectOccReviewBotRuleset(repository, githubApi) {
  const listed = githubApi(`/repos/${repository}/rulesets?includes_parents=true`, { allow: [403, 404] });
  if (listed.status !== 200 || !Array.isArray(listed.data)) {
    return {
      repository,
      state: "fail",
      ruleset_id: null,
      deltas: [delta("effective_rulesets.read_status", 200, listed.status || "runtime")],
    };
  }

  const matching = listed.data.filter((ruleset) => ruleset.name === REQUIRED_RULESET_NAME);
  if (matching.length !== 1 || !Number.isInteger(matching[0].id)) {
    return validateOccReviewBotRuleset(repository, matching);
  }

  const detail = githubApi(`/repos/${repository}/rulesets/${matching[0].id}?includes_parents=true`, { allow: [403, 404] });
  if (detail.status !== 200 || !detail.data) {
    return {
      repository,
      state: "fail",
      ruleset_id: matching[0].id,
      deltas: [delta("effective_ruleset_detail.read_status", 200, detail.status || "runtime")],
    };
  }

  return validateOccReviewBotRuleset(repository, [detail.data]);
}

export function rulesetDriftMarkdown(results) {
  const failures = results.filter((result) => result.state !== "pass");
  const lines = [
    "## Exact-head OCC Review Bot ruleset drift",
    "",
    `- Result: ${failures.length === 0 ? "PASS" : "FAIL"}`,
    `- Repositories checked: ${results.length}`,
    `- Repositories drifted: ${failures.length}`,
  ];

  if (failures.length) {
    lines.push("", "| Repository | Field | Expected | Actual |", "| --- | --- | --- | --- |");
    for (const failure of failures) {
      for (const item of failure.deltas) {
        lines.push(`| ${failure.repository} | \`${item.field}\` | \`${JSON.stringify(item.expected)}\` | \`${JSON.stringify(item.actual)}\` |`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

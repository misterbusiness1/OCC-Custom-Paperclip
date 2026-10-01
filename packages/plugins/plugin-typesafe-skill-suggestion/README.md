# TypeSafe skill-suggestion shadow

This private OCC experiment observes the final runtime skill catalog immediately before an agent turn. It performs a two-pass TypeSafe/Jev selection and writes sanitized run-log evidence only. It never changes prompts, enabled skills, permissions, identity, model selection, tools, or issue assignment.

The selector is disabled unless both conditions are true:

- `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW=true`
- `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID` names a running installation of this plugin

The plugin's own `enabled` setting must also be true. Its API key must be a managed `secret_ref`; the host never receives it. Default timeout is 5 seconds with one retry. Any worker, provider, timeout, rate-limit, or response failure returns control to the existing turn unchanged.

Rollback/disable is immediate: unset the host flag or set the plugin's `enabled` configuration to false. No database migration or cleanup is required. Ordinary logs contain only suggestion/no-match, shortlist probabilities, confidence, version identifiers, latency, token usage, outcome/error class, cache result, and terminal load attribution; raw request text and instruction bodies are not logged.

## Issue-classification shadow boundary

The same worker can observe `issue.created` and `issue.updated` through the read-only plugin event seam. This boundary is independently default-disabled and requires both `issueClassificationShadowEnabled=true` and `issueClassificationKillSwitch=false`. It sanitizes and bounds title (200 characters) and summary (500 characters), applies explicit-assignment, mandatory-policy, and reserved-human-authority rules before inference, then asks the pinned Choice/Noul v1.1.0 contract for one of `bug_fix`, `feature_build`, `report_or_dashboard_build`, `reporting_analysis`, `governance_review`, or `no_match`.

Only a plugin-scoped issue audit recommendation is persisted. The plugin manifest deliberately lacks `issues.update`, `issues.checkout`, `issues.wakeup`, agent, permission, configuration-write, and review/approval capabilities, so a recommendation cannot assign, change status, select authority, grant permissions, suppress review, or enable itself. Input revisions are re-read before persistence to discard stale responses. Concurrent duplicates coalesce; cache keys include input, contract, question, and model versions. Cache hits and coalesced observations record zero incremental tokens/cost and current observation latency.

Rollback requires no migration: set `issueClassificationKillSwitch=true` (the default), set `issueClassificationShadowEnabled=false`, or stop/uninstall the private plugin. Existing plugin-scoped audit rows are inert and may remain for review evidence.

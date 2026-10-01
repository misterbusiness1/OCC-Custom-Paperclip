# TypeSafe skill-suggestion shadow

This private OCC experiment observes the final runtime skill catalog immediately before an agent turn. It performs a two-pass TypeSafe/Jev selection and writes sanitized run-log evidence only. It never changes prompts, enabled skills, permissions, identity, model selection, tools, or issue assignment.

The selector is disabled unless both conditions are true:

- `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW=true`
- `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID` names a running installation of this plugin

The plugin's own `enabled` setting must also be true. Its API key must be a managed `secret_ref`; the host never receives it. Default timeout is 5 seconds with one retry. Any worker, provider, timeout, rate-limit, or response failure returns control to the existing turn unchanged.

Rollback/disable is immediate: unset the host flag or set the plugin's `enabled` configuration to false. No database migration or cleanup is required. Ordinary logs contain only suggestion/no-match, shortlist probabilities, confidence, version identifiers, latency, token usage, outcome/error class, cache result, and terminal load attribution; raw request text and instruction bodies are not logged.

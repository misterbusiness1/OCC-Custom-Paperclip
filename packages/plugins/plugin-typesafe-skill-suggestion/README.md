# TypeSafe skill suggestion

This private OCC plugin preserves the qualified shadow observation lane and adds a separately gated active advisory lane. TypeSafe/Jev chooses at most one ID from the current installed company skill catalog. Deterministic Paperclip code validates tenant, catalog membership, typed finite output, thresholds, and fresh revisions before appending a fixed sanitized advisory block to the adapter turn context.

## Enablement

Both host and plugin gates are required:

- Shadow: `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW=true` plus plugin `enabled=true`.
- Active advisory: `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE=true` plus plugin `enabled=true` and `activeEnabled=true`.
- `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID` must name the running plugin installation.
- `apiKeyRef` must be a managed `secret_ref`.

The active lane is default-disabled. Explicitly selected and mandatory skills suppress advisory injection. The model never controls permissions, company ownership, blockers, approvals, execution, tool access, or model routing.

Request and cache identity include company, managed binding and resolved secret-version revisions, plugin config revision, installed catalog revision, normalized-request fingerprint, question/contract version, and model. Secret/config metadata is re-read in the worker and the catalog is re-read in the host before a result is consumed. Timeout, rate limit, permission denial, malformed/non-finite output, stale revision, catalog mismatch, or exhausted bounded retries fail open to no advisory.

## Telemetry and rollback

Run telemetry preserves the existing `skill.suggestion.shadow` and terminal load-attribution events. Payloads contain only controlled IDs, probabilities, confidence, version identifiers, latency, token counts, outcome/error class, and cache state—never prompt text, raw customer content, secrets, resolved values, or skill bodies.

Rollback is immediate and requires no migration: unset `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE` or set `activeEnabled=false`. Disable all calls by unsetting both host flags or setting plugin `enabled=false`.

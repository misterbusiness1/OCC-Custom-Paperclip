# TypeSafe skill-suggestion shadow evaluation

Frozen fixture version: `occ-skill-shadow-2026-10-01.v1`

Contract: `skill-suggestion-shadow.v1`

Question: `occ-skill-suggestion.2026-10-01`
Model: `jev-1.13.0`

## Scope and safety

The sanitized fixture set covers matched and no-match requests, explicit skill requests, multiple plausible skills, ambiguous/adversarial text, and mandatory platform triggers. Explicit and mandatory cases bypass provider selection and retain the platform result. The output is shadow telemetry; it is not applied to the turn.

## Reproducible local evaluation

The deterministic test double exercises ranking, top-three refinement, pass-two rejection, explicit/mandatory precedence, cache invalidation, duplicate coalescing, timeout, rate limiting, invalid responses, and outage fail-open behavior:

```sh
pnpm --dir packages/plugins/plugin-typesafe-skill-suggestion test
pnpm --filter @paperclipai/server test -- skill-suggestion-shadow
```

## Results

| Metric | Baseline | Shadow | Result |
| --- | ---: | ---: | --- |
| Additional missed mandatory skills | 0 | 0 | Pass |
| Wrong first-load reduction | not measured | not measured | Live shadow sample required |
| Needless-load reduction | not measured | not measured | The ≥50% target is not yet demonstrated |
| Provider failures | n/a | deterministically fail open | Pass |
| Cache hit/coalescing | none | covered by tests | Pass |
| Latency/tokens/cost | not measured | emitted per observation | Live shadow sample required |

No claim of a 50% improvement is made. A live, sanitized shadow sample is required before an efficacy decision; this PR only establishes the default-disabled measurement path.

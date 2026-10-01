# GitHub Actions billing-refusal monitor

This OCC operational monitor runs from a Paperclip scheduled routine, not from GitHub Actions, so account-level Actions job refusals cannot stop detection. Its executable is `scripts/operations/actions-billing-refusal/index.ts`.

## Enable, cadence, and disable

Create a Paperclip routine assigned to the Plugin Engineer with schedule `*/5 * * * *` (UTC), concurrency `skip_if_active`, and catch-up policy `skip_missed`. The run procedure is:

```sh
pnpm actions:billing-monitor
```

Enable the routine only after setting the configuration below and completing a `--dry-run`. Disable or pause that routine as the kill switch; it makes no billing or repository mutations.

## Configuration and permissions

- `OCC_ACTIONS_MONITOR_REPOSITORIES`: comma-separated `owner/repository` allowlist.
- `OCC_ACTIONS_MONITOR_STATE_PATH`: absolute, persistent path under Paperclip-managed storage. The file is written atomically with mode `0600`.
- `OCC_ACTIONS_MONITOR_CTO_AGENT_ID`: CTO agent UUID receiving the single high/P1 issue.
- Normal run-scoped `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, and `PAPERCLIP_COMPANY_ID` values.

GitHub calls are executed only as `/usr/local/bin/onecli run -- gh api ...`. Grant that OneCLI identity read-only metadata access equivalent to GitHub `Actions: read` and `Checks: read`, plus repository metadata read access. No contents write, workflow write, administration, billing, or credential permission is required.

## Classification and triage

A confirmed refusal requires every structural condition: conclusion `failure`, elapsed time at most 30 seconds, zero steps, no runner name, and a value-free `404` from the job-log metadata probe confirming that GitHub produced no job log. A check-run annotation must also say that the job did not start and identify either failed payments or a spending limit. An annotation-unavailable structural match is only suspected when at least two distinct repositories match within 15 minutes. One heuristic-only job never alerts. A retained log or an unavailable/ambiguous log probe excludes the job from both confirmed and suspected classification.

Any assigned runner or executed step excludes the job, even when it failed. Those are repository CI failures and should be triaged by the repository owner, not as account billing refusals.

## Incident state, deduplication, and recovery

The version-2 state file stores the active incident issue ID, rolling-window start, UTC first/last seen, clear-window count, recovery-execution evidence, and accumulated value-free repositories, workflows, run/attempt IDs, PR numbers, confidence values, and sanitized reason categories. Its deduplication key is the active account-level category `github-actions-billing-refusal` plus the rolling 60-minute window start. Matches within that window union evidence into one incident instead of creating fan-out or erasing earlier polls. A later match starts a new window and incident with fresh evidence.

Existing version-1 state is migrated lazily on read: missing arrays are initialized empty and repository names are recovered from stored workflow keys, but unavailable historical run/attempt, PR, confidence, or reason data is never invented. To force a clean reset while the routine is disabled, move the state file aside and re-enable the routine; a missing file initializes version-2 empty state. Do not reset an active incident unless the CTO has captured its evidence, because the next detection will open a new deduplication window.

The incident contains only UTC timestamps, repositories, run/attempt IDs, unique PR numbers/count, confidence, and sanitized reason categories. It never contains annotations, logs, request/response headers, tokens, credentials, or environment values. Ownership is the CTO.

Recovery requires both two consecutive clear five-minute polls and evidence that the affected or equivalent workflow executed at least one step on a named runner. The monitor then closes the incident and clears active state.

## Verification

Retained fixtures cover the historical refusal (run `33078491252`, attempt 1, job/check `98538944295`) and the executed-failure control from attempt 6. Run:

```sh
pnpm test:actions-billing-refusal
pnpm actions:billing-monitor -- --dry-run
```

Dry-run output is deliberately limited to counts, repository names, confidence, sanitized reason categories, state transition, and recovery flags.

# OCC fleet CQE coverage collector

This isolated operations tool produces a deterministic, report-only inventory for the 39 repositories installed on the governed `occ-review-bot` GitHub App. It does not import Paperclip server modules and it never mutates GitHub, repositories, workflows, dependencies, Paperclip tasks, staging, or production.

## Scheduled invocation

The existing **OCC PR Review Queue and Weekly Quality Sweep** Paperclip routine invokes the collector during its Monday 09:00 ET quality-sweep leg. Do not create another schedule. The routine must invoke an immutable collector commit through OneCLI:

```sh
/usr/local/bin/onecli run -- node tools/occ-fleet-cqe/src/collect.mjs \
  --collector-sha "$COLLECTOR_SHA" \
  --run-issue "$RUN_ISSUE" \
  --repository-owner misterbusiness1 \
  --output fleet-cqe-coverage.v1.json \
  --summary fleet-cqe-coverage.md
```

The routine owns overlap prevention and uploads both artifacts to its execution issue with 13-month retention. The JSON is canonical and the Markdown is derived. Generated reports must not be committed.

[`routine-invocation.v1.json`](routine-invocation.v1.json) is the durable control-plane evidence record. It pins the active routine revision, CTO approval record, governed connection, invocation contract, artifact retention, and the reversible removal boundary. The routine owner must set `COLLECTOR_SHA` to the immutable merged collector commit; a feature-branch SHA is not a production schedule target.

The live readback captured on 2026-09-07 pins immutable routine revision `2b8da2f8-1d26-4e90-ac41-b9970816529a` (revision 5). The routine description contains the command above on its Monday leg, and the existing trigger remains `0 9,15 * * 1-5` in `America/New_York`; no second schedule, cron, or webhook was created. Authorized reviewers can inspect the revision history at `/api/routines/d346fd46-927a-47fa-86f4-5bc3ac9aca75/revisions` and compare its snapshot with the readback record.

## Coverage semantics

Schema `2.0.0` is defined by [`schema.v2.json`](schema.v2.json) and is additive over v1: existing repository, branch, review, coverage, and gap fields remain unchanged. New per-PR `cqe_latency` and `static_analysis` objects and repository-level `dependency_advisories` use explicit `measured`, `denied`, `unavailable`, `unsupported`, or `missing` evidence states. A measured zero is therefore distinct from unknown coverage, so Monday consumers can safely compute trends by including only `measured` records. No historical persistence layer is added; retained weekly artifacts remain the trend source. Existing v1 consumers may continue reading their known fields and ignore the additions; rollback is a revert to the v1 collector/schema.

Trend evidence retrieval is paginated in bounded 100-record pages. Exhausting the bound or losing access on any page discards partial results and marks the lane non-measured. When multiple PHPStan or PHPCS checks map to one tool, annotation counts and baseline deltas are summed across the complete set; if any mapped check has incomplete annotation evidence, the whole tool result is non-measured.

- Branch protection checks the default branch plus `main` and `production` when present. Required `OCC Review Bot` or `CQE` is `pass`; an accessible protection response without it is `fail`; denied access is `unknown`.
- Up to 100 recently updated closed PRs per repository are inspected by default. Merged PR bot-review states are `approved`, `stale_head`, `non_approve`, `missing`, or `unknown`.
- Dependency coverage passes only when a matching lockfile is present and the scheduled runtime successfully probes the corresponding audit command (`composer audit --help` or `npm audit --help`), or when the repository vulnerability-alert feed is verified enabled. Lockfiles alone never pass. Unavailable tooling and denied or disabled/unavailable alert access are `unknown`, never clean.
- Dependency advisory evidence counts open, non-dismissed Dependabot alerts by severity. Audit-command availability alone never produces a zero advisory count.
- Owner-assignment records are bounded by the inspected repositories/branches/PRs and keyed as `owner/name:kind:subject`. They are proposals only; v1 does not emit Paperclip or GitHub issues.

Collector/runtime/schema failure, a repository count other than 39, duplicate repositories, or artifact-upload failure is operational failure and must exit non-zero. Coverage findings and explicit unknowns remain report findings and do not by themselves change the collector exit status. The scheduler must treat upload failure as non-zero because upload occurs outside this process.

## Verification and rollback

Run deterministic tests with `npm test` from this directory. A live dry run must use the governed OneCLI identity and record the exact collector SHA and run issue.

Rollback removes the single invocation from the existing Monday routine and removes `tools/occ-fleet-cqe/` from a later repository commit. Delete only the generated artifact pair from a run issue if policy requires removing that run's output; historical artifacts otherwise remain audit evidence. No repository-local cleanup is required because the collector performs no target writes.

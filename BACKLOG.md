# Backlog

Pending technical work surfaced but not yet scheduled. File against
your tracker (Linear/Jira) when picking up.

=== Follow-up 1: Watchdog rearm bug (pre-existing) ===

Title: [bug] heartbeat watchdog: re-arm after quiet window not creating evaluation

Test "re-arms continue decisions after the default quiet window" fails
deterministically on master HEAD 48847c04 (2026-05-16).

Repro:
  pnpm --filter @paperclipai/server exec vitest run \
    src/__tests__/heartbeat-active-run-output-watchdog.test.ts

Result: 8 passed, 1 failed at line 399.
Expected: created=1, Received: created=0.

Likely cause: scanSilentActiveRuns has a guard that skips runs whose
source issue is in terminal state (done/cancelled). Test marks the
source issue as done before the rearm-window scan, expecting a fresh
evaluation; the guard prevents creation.

Fix paths:
  (a) update guard to allow rearm even if source issue terminal
  (b) update test to keep source issue open
  (c) update test to expect created=0 in this case

Discovered while shipping PR #5 (perf(sidebar-badges)).

=== Follow-up 2: Generated columns migration (deferred from PR #5) ===

Title: perf(heartbeat): add generated columns for context/result projection

Required generated columns on heartbeat_runs:
- context_issue_id uuid    = (context_snapshot->>'issueId')::uuid
- context_task_id uuid     = (context_snapshot->>'taskId')::uuid
- context_task_key text    = context_snapshot->>'taskKey'
- context_comment_id uuid  = (context_snapshot->>'commentId')::uuid
- context_wake_reason text = context_snapshot->>'wakeReason'
- context_wake_source text = context_snapshot->>'wakeSource'
- result_summary text      = left(result_json->>'summary', 500)
- result_message text      = left(result_json->>'message', 500)
- result_error text        = left(result_json->>'error', 500)

Plan:
  1. Migration adding STORED generated columns + index on context_issue_id.
  2. Update heartbeat-runs.ts schema definition.
  3. Backfill plan for existing rows.
  4. Cherry-pick projection changes from reverted commit 4edef34a.
  5. Decide canonical key for total_cost_usd
     (writers emit snake_case; reverted code expected camelCase).

Outcome:
  - ~580ms wall-clock saving per heartbeat listing query
  - jsonb scan -> indexed uuid filter on agents active-runs lookup

Refs PCLIP-3417, PCLIP-3422

=== Follow-up 3: CI gap (verify not enforced on master pushes) ===

Title: [ci] verify failures on master not blocking pushes

The watchdog rearm test has been failing deterministically on master
since at least 2026-05-16, yet master CI shows green. Master pushes
either don't run verify or don't enforce its result.

Action: audit .github/workflows/{push,master}.yml and align required
status checks for direct pushes to master with PR requirements.

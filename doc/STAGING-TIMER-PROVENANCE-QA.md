# Staging timer provenance QA fixture

Use this fixture only in an isolated Paperclip staging instance with synthetic
company, agent, and issue records. It does not authorize production use.

Configure a `process` adapter agent to run:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/repository/path/scripts/qa/synthetic-productive-executor.mjs",
    "<synthetic-issue-uuid>"
  ]
}
```

Initially set `runtimeConfig.heartbeat` to `{ "enabled": true, "intervalSec": 600,
"wakeOnDemand": false }`. Create the explicitly named synthetic issue assigned
to that agent in `in_progress` state. `wakeOnDemand: false` prevents the
assignment itself from replacing the required scheduled-timer origin.

Keep the agent paused during setup, then resume it without invoking an
on-demand heartbeat. Leave `wakeOnDemand: false` until the first genuine timer
has succeeded and its productive marker is persisted. Then, through the
staging operator API, change only `wakeOnDemand` to `true`, preserving the other
runtime settings. Recovery uses an automation wake, which is suppressed while
`wakeOnDemand` is false. The 600-second timer interval leaves time for recovery
before another timer can consume the marker. Do not enable on-demand wakes
before the successful source exists: assignment recovery could otherwise run
first. A second scheduled timer is not a recovery successor.

The process adapter derives `PAPERCLIP_WAKE_REASON` from runtime context. Do not
supply it in adapter `env` or a shell wrapper. Capture its value in stdout along
with `PAPERCLIP_RUN_ID`; a missing value fails this acceptance lane.

The fixture first checks out the explicit issue with the current run and fails
closed unless the response binds both `checkoutRunId` and `executionRunId` to
that run. The first scheduled run then writes one comment attributed to its real
run ID and exits successfully while leaving the issue in progress. The normal
recovery pass must enqueue the productive-terminal continuation. The second
invocation marks the issue done. Record both run rows and assert:

1. the source run has `invocationSource = timer`, runtime
   `PAPERCLIP_WAKE_REASON = heartbeat_timer`, persisted
   `contextSnapshot.wakeReason = heartbeat_timer`, and `issueId` / `taskId` equal
   to the synthetic issue UUID;
2. the continuation has source `issue.productive_terminal_continuation_recovery`;
3. the continuation `retryOfRunId` equals that exact timer run ID; and
4. heartbeat context still reports `heartbeat_timer` after coalescing.

For the fail-closed probe, repeat the recovery eligibility check with a
different synthetic run ID from either a second issue or second agent. It must
not enqueue a continuation. Do not alter a real run or use a cross-company
record. The focused `heartbeat-retry-source-scope` regression suite is the
deterministic oracle for this negative case; staging evidence must include its
passing mismatched-run case alongside the rejected live probe.

Keep the source `in_progress` and its assignee invokable while the recovery pass
runs. Confirm the successful source has productive liveness (such as `advanced`)
and an attributed comment before looking for its successor. Record the recovery
scan result or the skipped wake reason when no successor appears. Do not PATCH
run rows or manufacture `retryOfRunId` to satisfy the assertion. Pause the agent
once both run rows and the negative-probe evidence have been captured.

Rollback is deletion of the isolated synthetic company (or disposal of the
whole staging database) and removal of this process adapter configuration.

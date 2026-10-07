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

Set `runtimeConfig.heartbeat` to `{ "enabled": true, "intervalSec": 60,
"wakeOnDemand": false }`. Create the explicitly named synthetic issue assigned
to that agent in `in_progress` state. `wakeOnDemand: false` prevents the
assignment itself from replacing the required scheduled-timer origin.

The fixture first checks out the explicit issue with the current run and fails
closed unless the response binds both `checkoutRunId` and `executionRunId` to
that run. The first scheduled run then writes one comment attributed to its real
run ID and exits successfully while leaving the issue in progress. The normal
recovery pass must enqueue the productive-terminal continuation. The second
invocation marks the issue done. Record both run rows and assert:

1. the source run has `contextSnapshot.wakeReason = heartbeat_timer` and its
   `issueId` / `taskId` equal the synthetic issue UUID;
2. the continuation has source `issue.productive_terminal_continuation_recovery`;
3. the continuation `retryOfRunId` equals that exact timer run ID; and
4. heartbeat context still reports `heartbeat_timer` after coalescing.

For the fail-closed probe, repeat the recovery eligibility check with a
different synthetic run ID from either a second issue or second agent. It must
not enqueue a continuation. Do not alter a real run or use a cross-company
record. The focused `heartbeat-retry-source-scope` regression suite is the
deterministic oracle for this negative case; staging evidence must include its
passing mismatched-run case alongside the rejected live probe.

Rollback is deletion of the isolated synthetic company (or disposal of the
whole staging database) and removal of this process adapter configuration.

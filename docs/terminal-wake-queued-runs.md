# Queued runs with terminal wakes

A queued heartbeat run may outlive its linked wake request when the wake is
cancelled, failed, or skipped before provider execution. A terminal wake cannot
authorize a new turn. Startup and periodic queue recovery reconcile these
rows for every active company before ordinary claim admission.

The reconciler closes only a never-started run with an exact bidirectional
company, agent, wake, and run binding. It takes the existing issue lock (when
the issue still exists), then the wake lock, then the run lock. It checks for
controller identity, provider session/output, run events, task sessions,
environment and workspace leases, native finalization, workspace operations,
issue checkout/execution pointers, and deferred issue receipts. If any ownership
evidence is present, the run stays queued for operator investigation. Board
queued-comment interrupts use their own receipt-specific reconciliation.

An eligible run is compare-and-set to `cancelled` with
`queued_run_terminal_wake_without_execution`. The activity log records the
terminal wake ID and status and that no provider work was dispatched. The wake,
issue, and comments are not changed. A new Board request or authorized wake is
required to restart work. Ordinary claim admission checks the locked wake
again so a wake cancelled after the recovery scan cannot launch a provider.

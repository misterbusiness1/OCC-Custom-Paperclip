# Automatic completed-task inbox cleanup

Inbox offers **Automatically archive completed tasks from my inbox**, off by
default. Each board user must opt in. The choice is stored in this browser for
that user and company; changing companies or users does not carry the choice over.
If browser storage is unavailable, enabling cleanup fails visibly and stays off.

While Inbox is open, its existing Mine query refreshes supply the candidates.
Cleanup processes at most ten completed notifications per refresh, using the
existing per-user inbox archive operation. It creates no scheduler or daemon.
Active, blocked, cancelled and other-company tasks are excluded. Task records,
comments and history remain intact; ordinary manual archive and undo are unchanged.

The archive endpoint accepts an optional `expectedCompletedAt` timestamp for this
conditional operation. Under a task row lock, it checks that the task is still
completed at that exact timestamp and belongs to the target user's touched-task
inbox. Stale snapshots and previously archived completions return a no-op. The
automatic upsert can only move an existing archive timestamp forward; it cannot
overwrite a newer concurrent manual archive. The archive timestamp is the
completion time rather than the cleanup time, preserving
existing resurfacing rules for later genuine activity, including questions and
user mentions. A resurfaced notification is not repeatedly archived for the same
completion. A later completion after reopening is a new candidate.

Failures remain visible beside the checkbox. Failed requests do not hide rows;
a later query refresh can retry. Disabling cleanup stops queued operations after
the currently dispatched request. Closing Inbox stops additional queued requests.
No server setting or inbox cleanup is enabled merely by installing this feature.

Successful native issue activity invalidates company-scoped compact issue-list
caches before the write response completes. Reads already computing a previous
snapshot may finish for their original callers, but later reads cannot join them
and they cannot refill the cache. Detached reads retain their admission slots
until completion. Conditional archive no-ops publish no issue activity and leave
the cache unchanged; cache keys retain their existing actor/company boundaries.

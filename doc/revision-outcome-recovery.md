# Revision outcome recovery

The existing stranded-assignment sweep now also reconciles approval revisions. It uses the normal wake admission path for every adapter, including external adapters. It does not add a timer, change decisions, send messages, reassign tasks, or reopen completed tasks.

A successful provider run is execution evidence only. Domain outcomes come from the same approval card: `pending` means resubmitted; `approved`, `rejected`, or `cancelled` means disposed. A persisted human interaction, named dependency, other pending or revision-requested approval, current human owner, future monitor, paused agent or recovery action is a durable blocker. Otherwise the revision remains unresolved.

## Persistence and integration

`activity_log` stores `approval.revision_outcome` events against `entity_type = approval` and the card UUID. All reads and writes include `company_id`. The details include:

- `revisionKey`: approval UUID plus the revision decision timestamp. Payload edits do not reset this identity.
- `revisionDecidedAt`, `outcome`: `resubmitted`, `disposed`, `durable_blocker`, or `unresolved`.
- `requestedByAgentId`, `ownerAgentId`, `ownerUserId`, `linkedIssueIds`.
- `blocker`, `recoveryActionId`, `attemptCount`, `nextFollowUpAt`, `nextAction`.
- `executionActive`, `operatorHold`, `missingOwner`, `missingFollowUp`.

The queue integration can consume these events without treating runtime success as approval completion. `approval.revision_recovery_attempt` events reserve attempts before queue admission. These events are system evidence, not authorization to approve, reject, or execute the business proposal.

## Bounds and failure behavior

The sweep uses a rotating keyset cursor and at most 100 approval candidates per pass. PostgreSQL advisory locks serialize the same approval across independent server instances. Each revision permits at most three reserved recovery attempts, separated by 15, 30 and 60 minutes. A revision unresolved for 24 hours requires intervention. Active execution and explicit operator holds are preserved. Paused and archived companies are excluded.

A reservation commits before admission. A process crash, skipped wake, or admission exception therefore consumes a bounded attempt rather than losing the retry budget. A later sweep tries again after the recorded delay. Admission rechecks the exact decision and active company under shared row locks. The normal issue-state guard checks ownership and actionable status. Normal admission still enforces budgets, holds, dependencies, and runtime concurrency. No adapter-specific bypass exists.

At exhaustion, unavailable ownership, terminal linked task, or ambiguous multiple links, the existing recovery-action table records board-owned intervention for a linked task. It inserts without replacing any active action. Missing links are recorded as unresolved with explicit missing-owner/follow-up evidence for queue attention. Completed/cancelled issues are never reopened. An action owned by this revision is resolved when that card is resubmitted/disposed or a new revision decision supersedes it; unrelated recovery actions are preserved.

## Diagnosis and rollback

For a stale revision, inspect the latest company-scoped outcome and attempt events, the same card's current status/decision timestamp, linked issue ownership, pending interactions, wake receipts, and active recovery action. A reservation proves an attempted admission, not delivery. A run proves execution, not resubmission. Preserve human-only blockers and current active runs.

No schema migration is required. Revert the revision-reconciliation call and the generic-sweep exclusion together to disable this behavior. Keep activity history and recovery actions for audit; dispose of board actions explicitly through the existing control plane. Reverting does not authorize another business action, production rollout, or approval decision.

Source release qualification, independent exact-head review, staging, rollback snapshots and production board approval remain separate gates.

A single visible requester-owned issue in `blocked` can recover through the verified approval decision wake when no other unresolved dependency, interaction, approval, recovery action, unblock descriptor, or operator hold remains. The wake keeps the normal ownership and state admission guards. Cancellation settles the revision without another reservation or intervention, including after exhaustion, and resolves only its own recovery actions.

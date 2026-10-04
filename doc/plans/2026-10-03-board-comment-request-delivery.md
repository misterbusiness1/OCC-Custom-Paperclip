# Durable Board comment requests

Status: proposed repair design; implementation and qualification pending.
Scope: PR #132, ordinary issue comments authored by authenticated Board users with a `clientRequestId`. Conversation comments retain their existing outbox. Agent comments and unkeyed legacy writes retain their existing behavior.

## Defect and required behavior

The current route checks for an existing comment before any lock. Two first submissions can both miss and both reopen a workspace, mutate status, cancel execution, write activity and dispatch a successor. A later unique comment insert does not undo those effects. Separately, a crash after insertion but before the fire-and-forget wake loses the accepted intent, because the replay path returns immediately.

The request identity is `(companyId, issueId, authenticated userId, clientRequestId)`. One immutable accepted intent owns its effects. Same-content retries observe or continue that request; conflicting retries receive 409 before any effect. A restart must recover the durable request, not reconstruct intent from current mutable issue state or rerun the entire route.

This protocol guarantees idempotent control-plane admission and guarded recovery of recorded effects. It does not promise exactly-once arbitrary provider or filesystem actions.

## Existing patterns to reuse

- `issue_comments` already has a unique issue/user/client-request constraint.
- `agent-conversations.ts` uses comment rows as the conversation outbox; its recovery does not cover ordinary task comments.
- `question-response-delivery.ts` provides canonical payload hashing, bounded claims, claim-generation fencing, existing durable wake lookup and bounded delivery retries.
- `status_decision_effects` separates committed decisions from pending delivery effects and scopes idempotency by company.
- `issueService.update(..., tx, publications, postCommitActions)` supports transaction-bound issue changes and deferred publications. Those deferred actions must be represented durably for this protocol; an in-memory callback array is not a restart outbox.

## Durable records and migration

Add a narrowly scoped `issue_comment_requests` table. A new table is necessary: comment metadata is caller-controlled presentation data, comment rows do not record lifecycle or delivery phases, and the existing question/status tables require unrelated domain owners.

Fields:

- UUID primary key; company/issue composite foreign key; authenticated user ID; clientRequestId.
- Unique company/issue/user/request key and unique company/id key for child ownership.
- Versioned SHA-256 digest over the exact accepted request body, normalized deduplicated/sorted attachment IDs, `interrupt`, `resume`, `reopen`, and all accepted effect-bearing structured fields. Persist only routing/options and the digest in the ledger; the governed/redacted comment remains the authoritative content, avoiding a second undeletable body copy. Missing booleans canonicalize to false. Source trust and actor identity are server-derived, never accepted from the envelope.
- Accepted actor/source-trust context, immutable targeted run ID, expected issue status/version, selected assignee, and accepted workspace identity/generation when relevant. Persist only required context; no tokens or credentials.
- Nullable committed comment ID, phase, claim generation, lease/last-attempt timestamps, error code, bounded error count, created/updated timestamps.

Add `issue_comment_request_effects` with composite owner foreign key, stable ordinal, closed effect kind, immutable descriptor, per-effect status, claim generation, receipt/reference, bounded attempts and next-attempt timestamp. A company-scoped unique effect idempotency key prevents duplicate control-plane admission. Pending indexes cover only recovery scans and issue/company foreign-key access. No speculative performance indexes.

Add a partial unique wake index for the new `issue-comment-request:` idempotency namespace, matching the established durable-delivery statuses. Prefer one permanent wake identity per effect; retries inspect its terminal disposition instead of minting a new identity.

Generate migration with repository tooling, inspect SQL and snapshot, run migration safety and fresh/upgrade/rollback compatibility rehearsal. No production mutation during development.

## Admission and execution boundaries

1. Existing authentication, company visibility, ownership, Board pause and structured-field validation run first. Under the issue-row transaction lock, re-read relevant issue state and rerun mutable admission gates.
2. Compare any existing ledger digest. Different digest returns 409. Same digest returns its current outcome and requests recovery only for unfinished recorded work; it does not execute route lifecycle logic again.
3. For a new request, validate attachments and all effect-bearing fields before reserving acceptance. Build a closed typed effect plan from authoritative issue/run/workspace state. Persist immutable request, accepted comment, transactional issue status/decision changes, audit rows and pending effects in one transaction wherever effects are database-local. The planner must not perform filesystem reopen, cancellation, steering or wake calls.
4. Commit before external work. The worker claims one request/effect using a short transaction and monotonically increasing generation. It never holds an issue-row lock while calling existing services that acquire that row. No pool connection is pinned for a long provider/steering wait; no global mutex or lock-only pool is required.
5. Execute effects in recorded order with generation checks and durable receipts. Resume only the unfinished effect; never rerun the route or settled effects. Refresh claims only while the worker owns the generation, use bounded acquisition/backpressure and stop before a side effect if ownership is lost.
6. Successful HTTP response represents durable acceptance of the comment and intent. Delivery status is separately inspectable. Retry responses return the same comment ID. Existing clients may retain the normal 201 comment response, with an additive request/delivery status field or separate status lookup; do not falsely label an unresolved effect delivered.

### Specific effects

- **Database status, audit, references and confirmation expiry:** use the same transaction as their completion receipt. Make reference synchronization an idempotent replacement operation. Commit activity once; live publication can be repeated only if its transport is explicitly idempotent, otherwise publication uncertainty must not duplicate the audit record.
- **Workspace reopen:** persist exact workspace identity and expected generation. Reuse the existing generation fence and cleanup guard. On restart, inspect the resulting generation/state to establish a receipt. If completion cannot be determined, record `reconciliation_required`; never reopen a newer workspace generation blindly.
- **Interrupt:** capture one target run during admission. Call normal cancellation with the accepted Board actor and request correlation. On recovery, inspect that exact run and verified cancellation receipt; never select and cancel a successor. A terminal run with no matching receipt is not proof that this request cancelled it. Preserve preparing/dispatch-wins rules and malformed/reversed-receipt rejection.
- **Steer:** use a stable command correlation. Acknowledged delivery records the receipt. An ambiguous sent-but-unacknowledged command becomes `reconciliation_required`; do not steer twice or automatically fall back to a wake if execution may already have consumed the input.
- **Wake:** commit immutable target, context, original comment/intent IDs, actor and stable idempotency key as an outbox effect. Await durable wake admission. Before retry, query the exact company/key and reuse a valid existing request/run. A skipped/failed admission follows explicit bounded recovery policy; it must not silently count as success. The worker completes only after an accepted durable queue receipt exists.
- **Other existing post-commit actions:** inventory each action emitted by this narrow path. Convert required actions to typed durable effects; do not serialize executable closures or discard existing governance/watchdog behavior.

## Recovery and ambiguity

Integrate a bounded request/effect sweep with the existing recovery service. It scans only new-protocol unfinished rows, respects pause/approval/ownership gates, and uses immutable accepted intent plus current authorization checks. An expired claim is not permission to repeat an ambiguous external action. Reconcile recorded receipts first, then retry only demonstrably unstarted/idempotent effects. Unknown outcomes remain visible as `reconciliation_required` with source request, effect and evidence; they must not reopen finished work.

If the comment is deleted before delivery, stop its pending delivery and preserve only the tombstone/digest needed to prevent replay; do not recover deleted body or attachments. If user authorization or company membership is revoked before delivery, fail closed into a visible blocked outcome. Do not impersonate a synthetic Express actor to replay the original HTTP handler.

## Compatibility and rollback

Old saved comments have no trustworthy lifecycle envelope. Body-compatible replay may return their existing comment; changed content conflicts. Do not infer new intent, invent attachments/flags, or bulk enqueue historical comments. Preserve deleted-comment and username-redaction behavior when comparing accepted content.

New and old servers must not concurrently accept this protocol during migration/cutover: old writers do not consult the ledger. Use the existing guarded app cutover and preserve the additive tables on rollback. Once any new-protocol request is accepted, refuse rollback to a protocol-unaware server even if all effects settled; require a compatible rollback image or forward repair. Expose unfinished effects for reconciliation. Schema down-migration must not drop accepted work to bypass this guard.

## Files and extraction plan

- `packages/db/src/schema/issue_comment_requests.ts`, `issue_comment_request_effects.ts`, schema exports and generated migration/snapshot.
- `server/src/services/issue-comment-requests.ts`: canonicalization, atomic admission, claim/fencing and typed effect dispatcher.
- `server/src/routes/issues.ts`: route to the new service only for ordinary authenticated keyed Board comments; retain existing chat/agent/unkeyed branches.
- Extract the current ordinary-comment admission/status plan into a service using typed actor/context inputs; no mocked Express request reconstruction.
- `server/src/services/recovery/service.ts`: bounded startup/periodic pending-delivery recovery.
- `server/src/services/heartbeat.ts`: only the minimal new wake-idempotency namespace handling, and cancellation correlation if current receipt lacks it.
- Focused service, route, database migration and recovery tests; documentation of accepted versus delivered state.

## Acceptance evidence

1. Real PostgreSQL, two independent service/router instances, two first submissions held at the admission race: one request/comment, one status/audit/reference/cancellation path, one successor; identical responses share the comment ID.
2. Concurrent changed body, attachment IDs or interrupt/resume/reopen produces deterministic 409 and no follower effects. Different users/issues/companies cannot replay one another. Semantically identical attachment sets canonicalize identically.
3. Independent keys progress concurrently, including a saturated small normal DB pool; no global serialization, leaked connections or indefinitely queued lock waiters.
4. Crash/throw after each committed phase, especially comment acceptance before wake and wake persistence before acknowledgement. Recreate service/router, recover original intent once, verify settled effects do not repeat and active/queued residue drains.
5. Expired/lost claims and competing workers fence stale generations. Ambiguous steer/workspace/cancel outcomes remain visible for reconciliation rather than replay.
6. Preparing interruption and dispatch-wins tests retain actual successor, actor and intent assertions; malformed or reversed cancellation receipts fail closed.
7. Authorization revocation, pause, deleted comments, redaction, attachment authorization, closed workspaces, auto-approval, scheduled retry and watchdog behavior remain intact.
8. Legacy replay causes no new wakes. Conversation and agent suites remain unchanged in behavior. TypeSafe/Kimi/Gemini regression lanes pass on final combined head.
9. Required CI, independent adversarial review, additive migration/upgrade/rollback rehearsal, canonical build and fresh Browser QA on exact final artifact precede production authorization.

Open design review point: whether the existing cancellation receipt carries a stable request correlation sufficient to reconcile the crash boundary. If not, add that immutable correlation to the existing receipt rather than treating a generic cancelled status as delivery proof.

## Alternatives considered

| Approach | First-writer race | Restart delivery | Decision |
| --- | --- | --- | --- |
| Unlocked early lookup | Both first requests can mutate | Saved comment can lose wake | Reject; current defect. |
| Process-local keyed mutex | One process only | Lock vanishes; intent absent | Reject; multiple servers and restart unsupported. |
| Long issue-row transaction around current route | Nested service writes can deadlock | External effects cannot roll back | Reject. |
| Separate advisory-lock pool around route | Serializes matching live requests | Lock loss and insert-to-wake window remain | Reject as final repair. |
| Insert comment first and return duplicates | Atomic comment ownership | First request may die before effects; no phase evidence | Reject without outbox. |
| Durable request and ordered effects | Atomic intent admission; unique identity | Reconcile or continue recorded unfinished effects | Selected; additive schema and focused dispatcher. |

## State transitions

| Current state | Evidence/event | Next state and allowed action |
| --- | --- | --- |
| No record | Invalid authorization, pause, attachments or request fields | Reject; no request/comment/effects committed. |
| No record | Authorized issue-row admission transaction commits | Request pending; comment and immutable effect plan committed together. |
| Existing record | Digest differs | 409; no follower mutation. |
| Existing record | Digest identical | Return same accepted comment; request pending delivery may be scheduled, never whole-route replay. |
| Effect pending | Worker claims generation under row lock | Claimed; short database transaction ends. |
| Effect claimed | Generation still owned immediately before external call | Dispatching; persist uncertain boundary first. |
| Effect claimed, expired | No dispatching boundary was committed | New generation may claim the unstarted effect. |
| Effect dispatching, expired | Durable receipt proves completion | Delivered; resume next effect only. |
| Effect dispatching, expired | Outcome cannot be proved | Reconciliation required; no automatic reexecution. |
| Database-local effect pending | Effect plus completion receipt commit in one transaction | Delivered atomically. Rollback leaves pending. |
| Any unfinished effect | Comment deleted or authorization revoked | Cancelled or blocked, with closed reason code; do not deliver removed content. |
| All effects delivered | Durable receipts present | Request delivered; all subsequent replays are read-only. |
| Request with uncertain effect | Explicit evidence-based reconciliation | Resume only proven-unstarted/idempotent effects or mark settled; no blanket reset. |

Rejected requests have no durable accepted intent. Accepted requests remain inspectable when blocked or uncertain; they are never reported as completed delivery merely because the HTTP comment response succeeded.

### Actor and responsible identity

Admission derives authenticated Board user identity and responsible-user identity through the existing actor policy; neither is read from the submitted JSON. Store the minimal immutable actor provenance needed for audit/cancellation/wake correlation. Recovery revalidates current membership/authorization using typed service inputs. It must preserve the accepted responsible-user identity and source trust, and must not manufacture a login, bearer token, or Express request.

### Enforceable downgrade boundary

A protocol-unaware server is incompatible after **any** new-protocol request is accepted, even when every effect is delivered: its old replay handler can mutate the issue before recognizing the existing comment. The release preflight must call `assertCommentRequestRollbackSafe(db, targetProtocolVersion)` before selecting a rollback target. A target with protocol version zero is refused once any version-one ledger row exists. Therefore the app-only rollback image must itself support this protocol after activation; alternatively roll forward to a compatible repair. Draining pending requests alone is insufficient. Manual bypass is not a supported rollback. Preserve the additive ledger and its records through rollback; do not delete accepted intent to satisfy the guard.

## Revision 2: bounded answers to CTO review

This section supersedes any less precise wording above. The isolated ledger prototype is not the approved implementation and must be brought into conformance before route integration.

### Canonical equality, governed content and attachments

Canonical v1 consists of: protocol version; company/issue; authenticated and responsible user identities; immutable admission-policy receipt; governed body; governed presentation/metadata; explicit author type; normalized boolean interrupt/resume/reopen; and attachment identities **in first-occurrence request order**. Duplicate attachment IDs collapse without sorting. A changed ordering therefore conflicts. This replaces the earlier unordered-set proposal.

The ledger stores the non-content envelope, accepted comment revision marker and digest. The accepted comment owns the body/presentation/metadata; no duplicate plaintext body is stored in a separate indefinite ledger. Canonical text uses the same governed username-redaction normalization as comment persistence, with its normalization version captured at admission. Compare a replay by (1) current authorization check, (2) revision/deletion check, (3) digest fast rejection, and (4) full canonical material equality against the unchanged governed comment plus immutable ledger envelope. A digest match alone is never enough. Tests force a digest collision to prove step 4 rejects different material. If the comment was edited/redacted after admission, fail replay closed with 409 `comment_request_content_changed`; do not infer a new original. A deleted comment returns 410 `comment_request_deleted` to an otherwise authorized owner and never delivers its old content. The corresponding edit/delete service transition cancels pending content delivery; receipt-only reconciliation and stop cleanup may still finish. An incoming body differing only in data intentionally removed by the captured redaction rule is equivalent governed content, not a retained second plaintext identity.

Verified schema: `assets` has `sha256`, `byteSize`, `companyId`, `provider` and unique company/object key; `issue_attachments` binds company, issue, asset and comment. The schema does **not** prove these rows can never mutate. Therefore admission locks and authorizes the attachment/asset rows, validates same company/issue and unbound-or-this-comment ownership, and stores `{attachmentId, assetId, sha256, byteSize}` in accepted order. Validate every current row against that tuple before first delivery and before replay reuse. Missing, rebound or changed integrity is a closed conflict/blocked delivery, not silently refreshed input. Do not copy filenames or file contents into the ledger. Storage download retains the existing integrity checks; new work cannot assume a mutable object key alone is immutable evidence.

### Cancellation correlation decision

Source inspection at PR132 `359e719` confirms `operatorInterruptCancelOptions` records issue and actor but **no request/effect correlation**. Add `commentRequestId` and `commentRequestEffectId` to server-generated cancellation `resultJson` and event payload, using the immutable ledger/effect IDs. Existing run JSON can carry this without a new run column. It must be written through the normal cancellation settlement path and checked together with company, exact target run, actor, stop-kind and the validated preparing/dispatch receipt. The effect unique key owns one target; never use a generic cancelled status or another request's correlation as completion proof.

Recovery rules: if the matching settled receipt exists, record delivery without calling cancel again. If the recorded run finished naturally before cancellation, record `not_needed_target_already_terminal` only after proving no dispatch was attempted by this effect; this is not an interruption receipt and must not trigger interrupt-specific successor semantics. If an attempted cancellation lacks a matching verifiable outcome, require reconciliation. Do not overwrite another effect's correlation. Tests cover concurrent different requests targeting the same run, stale/malformed/reversed receipts, natural completion, preparing and dispatch-wins.

### Authority per effect

Policy source: existing company/actor gates and task pause/approval/ownership gates in `routes/issues.ts`; the protocol adds no authority.

- Admission-only database changes (accepted comment, authorized status/review decision, binding, audit) use authorization checked under the admission transaction. They are not undone on later membership revocation.
- New execution effects (workspace reopen, interrupt not yet attempted, steer, assignee/mention/review/dependency/parent wake) require current membership, issue access and applicable pause/approval/ownership gates before dispatch. Revocation blocks the effect visibly, preserving accepted intent and audit. A Board operator may explicitly reconcile or discard; a new worker cannot grant authority.
- Content-derived reference/external-object synchronization requires the accepted comment still exists at its accepted revision; revoked authority blocks new outward influence. Existing database projections may be cleaned after deletion without user execution authority.
- Receipt inspection, cancellation settlement already initiated, workspace guard cleanup, sandbox teardown for an already committed terminal transition and audit publication are system reconciliation of committed control-plane state. They do not start new user work and may finish after revocation. Preserve original authenticated/responsible attribution; label recovery actor separately as system.
- Unknown authorization outcomes fail closed to visible blocked status. No synthetic login/Express actor is created.

### Closed effect inventory from current keyed Board route

| Existing route operation | Durable boundary |
| --- | --- |
| Validate request, actor/company access, pause, resume/blockers, presentation/source trust and attachment ownership | Admission reads; reject before acceptance if invalid. |
| Workspace reopen plus generation-specific unused-workspace cleanup | Recorded `workspace_reopen` and `workspace_cleanup` effects; exact generation receipt, ambiguity requires reconciliation. |
| Supersede scheduled retry cancellation | Recorded `cancel_scheduled_retry` effect targeting the captured retry run; receipt correlation required. |
| Implicit/explicit status-to-todo transition and its audit | Admission transaction, or a recorded database-local effect ordered after required workspace readiness; state and receipt commit together. |
| Interrupt currently selected active run and cancellation audit | Recorded `interrupt`; exact recorded run/correlation; cancellation audit commits with verified effect receipt. |
| Comment insertion and attachment binding | Admission transaction. |
| Auto-approval execution-policy transition and decision row | Admission transaction with comment, or ordered database-local transition if workspace prerequisite applies; existing policy gates retained. |
| `cancel_native_question_run` postcommit action | Existing durable cancellation marker plus request effect reference; recovery already consumes marker. No in-memory-only required action. |
| Issue-reference synchronization and resulting reference audit detail | Recorded database-local `references` effect with receipt in same transaction. |
| External-object synchronization | Recorded `external_objects` effect; database-only idempotent synchronization as supported by service, otherwise reconcile ambiguity. Never swallow failure as delivered. |
| Live goal steer | Recorded `steer`; stable command ID, verified acknowledgement; no automatic fallback after ambiguous send. |
| `issue.comment_added` audit and live publication | Audit row transaction-bound once; separate durable publication receipt. Live client transport dedupes by activity ID. |
| Superseded request-confirmation expiry and audits | Database-local `confirmation_expiry`, transaction-bound with receipt. |
| Active source-recovery revalidation | Recorded `recovery_revalidation` effect preserving original intent/source and governance. |
| Review-stage, assignee/reopen, mention, dependency-resolved and parent-completion wake decisions | Closed wake-plan variants, one stable effect key per target/issue; durable wake admission and receipt. Fresh target/gate checks may block outdated plan, not silently retarget to a different agent. |
| Terminal pending-interaction expiry/audits | Database-local `terminal_interaction_expiry` effect. |
| Destroy reusable sandbox leases after committed terminal state | Recorded `sandbox_cleanup`; idempotent known lease identity or explicit ambiguity. |
| Task watchdog evaluation | Recorded `watchdog`; durable idempotent scheduling receipt. |

The Board path has no agent `runId`, so agent activity reporting and direct-parent/cross-issue influence counters are excluded. Assignee-run delegation mention expansion is also excluded for genuine Board comments; Board mentions remain wake-plan variants. If implementation reveals an additional effect, extend this closed table and tests before shipping; do not route it through an untyped generic callback. `commentCreatedByRunId` must remain absent for the genuine Board path.

### Switches, HTTP and compatible cutover

Introduce independent `PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED` and `PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED` controls, both default false until the canonical rollout explicitly activates them. Disabled admission returns 503 `board_comment_request_admission_paused` for all in-scope keyed Board writes; it never falls through to the legacy handler. Existing accepted requests still permit read-only status lookup. Disabled dispatcher stops new claims, lets already-owned safe settlement finish, and exposes pending/ambiguous counts; it never clears claims or marks work delivered. Re-enable resumes bounded recorded work. The feature needs both controls enabled for normal operation; it is not a pilot limited to selected companies.

HTTP: accepted initial request and identical replay return 201 with the original comment JSON shape; retain additive `commentRequest: {id, protocolVersion:1, status}` only if callers tolerate it, otherwise provide the same data exclusively via authenticated `GET /api/issues/:issueId/comment-requests/:clientRequestId`. Different canonical material returns 409 `comment_request_conflict`, edited accepted content returns 409 as above, deleted accepted comment returns 410, permission denial retains existing 403/404 behavior, and admission-off returns 503. A 201 means accepted, never proof of agent execution. Status lookup is company/issue/owner scoped; Board operators with existing task-management authority may inspect other owners without seeing credentials or raw ledger payload. UI can keep the existing comment response and query status for pending/reconciliation indication.

Cutover: quiesce admission on every old writer and drain in-flight writes; rehearse then apply additive migration (prebuild/verify permanent wake index concurrently on the large table); replace all serving binaries with a protocol-capable version while both controls remain off; verify no old writer/dispatcher remains; enable dispatcher then admission across all companies. Do not serve keyed writes on mixed old/new versions. Mandatory release preflight and rollback command must query protocol version/count and refuse an unaware target after any v1 row. The actual production cutover script must import/call this guard; a standalone helper or documentation is not sufficient evidence. Before activation with zero rows, old rollback remains available. After first acceptance, use a compatible rollback image or forward repair. These are release prerequisites, not claims already fulfilled by the prototype.

### Retention and operational contract

| Record | Retention/cleanup |
| --- | --- |
| Rejected pre-admission request | No accepted ledger; normal bounded security/audit retention only. |
| Pending/claimed/dispatching, blocked or reconciliation-required | No automatic deletion; preserve until explicit disposition and all evidence obligations end. |
| Delivered/cancelled request identity, version, canonical non-content envelope/digest and effect receipt references | Retain for issue lifetime; no finite replay guarantee is advertised. Never delete to permit unsafe downgrade. |
| Deleted-comment tombstone | Preserve identity and non-content integrity evidence; erase governed body via existing deletion, stop content delivery. |
| Hard issue/company purge | Existing authorized purge must delete child effects then request ledger then comments/issue, atomically respecting foreign keys; excluded from ordinary cleanup. No new automatic purge job. |

Expose structured events/counters `board_comment_request.accepted`, `.replay`, `.conflict`, `.blocked`, `.reconciliation_required`, `.claim_expired`, `.stale_claim_fenced`, `.wake_admitted`, `.switch_state`; gauges `board_comment_request.pending_count` and `.oldest_pending_age_seconds`. Labels: protocol/effect/state/company only where existing local metrics policy permits; never body, filenames, credentials, bearer tokens or request payload. Correlated local events contain request/effect IDs and closed error codes. Use existing local run/activity observability, not a new external telemetry channel.

Operational target: uncontended acceptance under the existing API SLO; pending delivery normally admitted within one recovery sweep (target 30 seconds). Alert immediately on reconciliation-required or stale-claim writes attempted; warn if pending age exceeds 60 seconds with dispatcher enabled, escalate at 5 minutes. Expected governance/auth blocks are visible actionable state, not falsely reported provider failures. Switch-off state suppresses delivery-latency paging but retains queue gauges. Status lookup exposes accepted/delivered/blocked/reconciliation_required and safe reason, created/last-attempt timestamps and authorized task links.

### Revised evidence matrix

In addition to the original tests, force hash collisions; preserve attachment order and verify asset hash/size/company/issue binding; edit/delete accepted content before dispatch and replay; verify same authenticated actor with changed responsible policy does not rewrite accepted provenance; test each effect's revocation rule; kill admission/dispatcher independently without legacy fallthrough; reject old-target rollback after settled rows; exercise mixed-version refusal before enabling admission; and cover every inventory row at its pre/post-commit crash boundary. Inspect actual mandatory release guard invocation and permanent wake uniqueness across terminal statuses. A component test is not evidence that the HTTP route or operational cutover is integrated.

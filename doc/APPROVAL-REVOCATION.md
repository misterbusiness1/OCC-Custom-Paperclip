# Withdraw an approved request

Board users can revoke an approved `request_board_approval` from its detail page,
or `POST /api/approvals/:id/revoke` with a nonempty `decisionNote` and the exact
ISO `expectedUpdatedAt` displayed by the caller. Ordinary rejection continues to
accept only pending or revision-requested cards. Hire and budget decisions cannot
be reversed through this endpoint.

Revocation locks the current approval and its company-scoped action requests,
invocations and live decision runs. It refuses stale versions and known started
or completed execution, including terminal invocations with a recorded start. On success, one transaction changes the approval to
`cancelled`, cancels its pending/approved tool actions and unstarted decision
wakes/runs, and writes `approval.revoked` with the previous decision and cancelled
IDs. Publication happens after commit and never emits an executable approval
hook or resumes the requester. It leaves linked tasks and other approvals alone.
A competing native action claim either wins first (revocation refuses with
`approval_execution_started`) or loses to the cancelled action. Provider delivery
is not undone; existing native execution still requires current formal approval.

This is future-authority withdrawal, not a refund, unsend or rollback. External
systems outside this control plane cannot be retroactively cancelled. If an
external action has started or its outcome is uncertain, reconcile it before
selecting another action. Revoking historical decisions does not permit deleting
history or copying a spent action into a new card. A new proposal requires its own
review, execution conditions and verification.

Post-decision requester and review-path delivery hold a shared lock on the exact
current approval version before handing tasks back or admitting wakes. Revocation
holds the conflicting update lock. A revocation that wins suppresses late delivery;
a delivery that wins exposes its queued or claimed work to revocation's checks.
The lock uses the existing dedicated-connection helper so waiting deliveries do
not exhaust the ordinary wake-admission connection pool.

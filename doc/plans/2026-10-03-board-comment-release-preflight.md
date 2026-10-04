# Board comment protocol release preflight

This is a read-only deployment prerequisite. It does not replace the operator's
cutover program and does not deploy, stop, migrate, drain, or enable anything.
The actual production cutover integration remains a release requirement.
Do not use the npm dist-tag rollback script as application rollback. Staging
restore scripts have separate database semantics and cannot substitute for this guard.

The database guard enforces the greater of the retained minimum protocol in the
singleton instance settings row and the highest protocol on any remaining request,
including settled requests. Legitimate issue deletion does not lower that retained
minimum. Missing or malformed migrated metadata fails closed; only a genuinely
pre-migration database may qualify without either structure.

## Trust and evidence

Run `scripts/check-board-comment-protocol-release.ts` from a reviewed source/image
that includes the guard. Use the trusted deployment connection in `DATABASE_URL`.
Do not put that value in command-line arguments, evidence JSON, or logs.

The operator supplies the exact target image digest, source commit, and externally
pinned SHA256 of two files. A file's own claim about its hash or protocol is not
approval. Qualification must establish the immutable image/source relationship,
read the source-owned `BOARD_COMMENT_REQUEST_PROTOCOL_VERSION` marker, hash that
source capability evidence, and prove the protocol contract with independent
review and tests. For old images, qualification must explicitly prove absence of
protocol support and attest version zero. Environment flags never establish
protocol capability. Neither arbitrary file creation nor computing its hash
makes a qualification trusted.

Qualification schema:

```json
{
  "schema": "paperclip.board-comment-protocol-qualification.v1",
  "imageDigest": "sha256:<64 hex digits>",
  "sourceCommit": "<40 hex digits>",
  "protocolVersion": 1,
  "sourceCapabilitySha256": "<64 hex digits>",
  "protocolContractVerified": true
}
```

Collect observations under the real deployment lock, immediately before each
check. Derive flags from actual container inspection, not desired Compose.
Enumerate every app writer, including replicas and separately launched workers.
An incomplete inventory must fail; an empty list is valid only after proving
there are no writers. Derive in-flight counts from authoritative app/DB evidence.
An old process without request counters must be stopped, rather than assumed idle.
Verify the database identity matches the target instance. Keep the lock and
quiescence through the guarded action; the receipt is not a persistent lease.
Observations older than 30 seconds or from the future are refused.

Observation schema:

```json
{
  "schema": "paperclip.board-comment-release-observation.v1",
  "observedAt": "<current UTC ISO timestamp>",
  "writerInventoryComplete": true,
  "releaseLockHeld": true,
  "databaseIdentityVerified": true,
  "admissionsInFlight": 0,
  "dispatchesInFlight": 0,
  "migrationAttestationVerified": true,
  "dispatcherReadinessVerified": true,
  "dispatcherReadinessImageDigest": "sha256:<qualified image digest>",
  "writers": [{
    "id": "<container ID>",
    "running": false,
    "serving": false,
    "flagsSource": "container_inspect",
    "imageDigest": "sha256:<observed image digest>",
    "sourceCommit": "<observed source commit>",
    "admissionEnabled": false,
    "dispatchEnabled": false
  }]
}
```

The two flags refer to `PAPERCLIP_BOARD_COMMENT_REQUEST_ADMISSION_ENABLED` and
`PAPERCLIP_BOARD_COMMENT_REQUEST_DISPATCH_ENABLED`. Missing flags default off.
The receipt must preserve admission-off behavior without legacy fallback.

## Mandatory actual-cutover integration

The new production cutover program must call this CLI and require exit zero at
these boundaries. A failed check aborts the transition; it never falls through
to an older script or automatically selects an unqualified image.

1. **pre-swap:** disable admission and dispatch in compatible current writers;
   let owned work settle; preserve pending/ambiguous durable intent; stop all old
   app writers. Both observed switches must be off and in-flight counts zero.
   Perform the exact target's ledger compatibility check before selecting it.
2. Apply only the separately qualified additive migration and app replacement.
   Preserve all request/effect records. Start only the qualified compatible
   image, with admission off. Do not serve an old writer beside it.
3. **dispatcher-ready (mandatory before enabling admission):** attest the actual migration and all serving writer
   images/sources. Dispatch is on and admission remains off. Prove readiness
   using actual isolated protocol checks and current health; do not infer it
   from a desired flag or merely from a running container.
4. **activation (post-change verification, not permission to enable):** only after
   the dispatcher-ready pre-enable gate passes for this exact image, enable
   admission. Inspect actual flags again; both must be on and every serving
   writer must match the qualified image/source. Keep the external admission
   gate closed until this check succeeds, then release it and test real tasks.
5. **rollback:** disable both switches, settle/stop writers, and call the guard
   against the independently qualified rollback target before any image swap.
   Any ledger row with a higher protocol version rejects that target, including
   delivered/cancelled rows. Clearing a queue or waiting does not permit an
   unaware rollback. Use a qualified compatible image or forward repair.

### Startup-only switch constraint

The current controls are startup environment variables, not live API toggles.
Stopping a container does not change its configured environment. An inspected
stopped writer with either flag true therefore does not pass the pre-swap or
rollback policy. The collector must not rewrite those values to false.

The actual cutover must first hold new admissions at the external ingress and
establish request/dispatcher quiescence with authoritative evidence. Where the
current writer has enabled startup flags, use a separately reviewed, controlled
maintenance transition: replace it with the same protocol-compatible artifact
configured with both switches false, while the ingress hold remains in place.
Preserve its durable ledger and inspect the maintenance generation's real flags.
Verify the replaced writer is gone and no replica/worker remains. Let supported
settlement finish, then stop the maintenance writer and run pre-swap/rollback
against that complete current inventory. Keep replacement/removal evidence for
the preceding generation; do not omit a still-present writer from the inventory.

This extra startup transition must be part of the qualified cutover and shutdown
rehearsal, not an untested restart added during an incident. If safe quiescence or
a compatible maintenance artifact cannot be established, the phase fails and
requires a qualified forward repair or operational plan. An old protocol-zero
writer with absent switches is already observed off; it must still be stopped
and all in-flight writes drained. The generic task drain alone is not proof that
Board comment HTTP requests have stopped.

The dispatcher-ready check must run immediately before the actual enable step
while ingress remains held. After the enable step, activation inspects the new
actual flags and verifies the exact image again before reopening ingress. A
post-change activation receipt cannot retroactively make an unsafe enable safe.

Before migration, the service guard uses `to_regclass` to establish whether the
ledger exists. Query failure is not absence. Never drop the ledger, erase rows,
or down-migrate accepted intent to make an old image appear compatible.

Example command shape (pins and paths come from the approved cutover record):

```sh
node --import ./cli/node_modules/tsx/dist/loader.mjs \
  scripts/check-board-comment-protocol-release.ts \
  --phase pre-swap \
  --target-image "$qualified_image_digest" \
  --target-source "$qualified_source_commit" \
  --qualification "$qualified_receipt_file" \
  --qualification-sha256 "$approved_receipt_sha256" \
  --observation "$fresh_observation_file" \
  --observation-sha256 "$fresh_observation_sha256"
```

The CLI also calls `assertCommentRequestRollbackSafe` in all phases. It emits
only closed failure text, or a successful target/phase receipt without secrets.
A passing helper test is not evidence that the production cutover invokes it.

## Validation

- `node --test scripts/check-board-comment-protocol-release.test.mjs` tests
  immutable pins, source mismatch, missing evidence, stale observations, mixed
  writers, switch phases and readiness.
- The service tests cover real PostgreSQL ledger compatibility, including a
  settled accepted row and a pre-migration database.
- Actual release qualification must exercise this CLI against the exact
  artifact and rehearsal database, then inspect the new production tool's
  mandatory invocation and abort behavior before approval.

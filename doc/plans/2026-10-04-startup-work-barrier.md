# Held startup for qualified cutover

A running process is not database quiescence. Backup and migration still require the complete writer inventory to be stopped. This barrier holds application business work while an operator verifies the new process and its protocol schema; it does not replace the stopped-writer boundary.

## Operator contract

Set `PAPERCLIP_STARTUP_WORK_HELD=true` before starting the target. The setting is read once at module initialization. Missing/`false` preserves normal startup; other spellings fail startup. Every restart creates a new held boot. There is no dynamic rehold or drain claim.

`GET /api/startup-work-barrier` requires instance-admin authentication. It returns:

- `startupWork`: `bootId`, `generation` (initially 0), `configuredHold`, `held`, `qualificationSha256` (initially null).
- `startupRecovery`: bootstrap/recovery phase and timestamp. A held ready boot has database/auth/source readiness; plugin execution and business recovery are deliberately deferred.
- `protocol`: source-defined version, same `processBootId`, configured flags, effective `controls`, startup hold snapshot and admission/dispatch in-flight counts. Effective flags are false while held, even if both are configured true.

The GET fails closed if the required protocol tables or retained compatibility checks fail. It is not a test of external providers.

After the canonical external release guard succeeds, the authenticated operator posts to `/api/startup-work-barrier/release`:

```
{
  "expectedBootId": "observed UUID",
  "expectedGeneration": 0,
  "qualificationSha256": "64 lowercase hex characters",
  "expectedProtocolVersion": 1,
  "expectedConfiguredControls": {"admission": true, "dispatch": true}
}
```

The route freshly checks database protocol compatibility, bootstrap readiness, configured flags, source protocol version, and zero protocol operations in flight. Its synchronous transition validates boot/generation and consumes the permit once. Wrong boot, changed controls, stale/repeated permit or incompatible database leave the hold in place. Qualification digest is an authenticated operator provenance record, not a signature or independent proof of its contents. The external guard must bind its packet to the database, source/image, migration ledger, manifest, approval and this observed boot before posting.

Release is the business-work commit. It does not restart the process. The response records generation 1 and the digest; deferred recovery subsequently moves through recovering to ready. If deferred recovery fails, the process remains non-ready and requires explicit investigation. A failed response after a successful release may still mean work has started: inspect this same boot's status rather than resubmit or automatically restart/rollback.

## Work boundaries

- HTTP is denied with 503 while held, except identity authentication, health and authenticated operator status/release. GET business routes are denied too because some reconcile state.
- Heartbeat direct admission, execution and queued resume use scheduling suppression. Durable Board admission and direct effect dispatch independently consult the barrier, including when tests inject enabled protocol controls.
- Index business startup is deferred as a unit: execution-control recovery, queued/native heartbeat recovery, routines/status cards, tool/question/connection deliveries, external refresh, provider/workspace cleanup, retention and scheduled backup setup. Its timers are not installed until release. Existing heartbeat-disabled behavior is preserved after release.
- Plugin installation/loading, worker initialization and tool-dispatcher initialization are deferred. Managed environment provisioning waits until release and completes before heartbeat startup. Third-party initialization is executable code, not trusted read-only readiness.
- Email polling keeps its timer but returns before database/provider access while held; after release it resumes on its next tick. Email/chat business APIs, plugin jobs/events/worker RPC and external/routine/tool direct service operations have their own gate.
- Feedback export and chat publication signals/timers are held. Runner PRP, custom-image terminal and live-event websocket upgrade paths reject with 503 before authentication/session/provider work; Express middleware does not handle upgrades.

## Allowed bootstrap and limits

Database migrations/bootstrap, auth/session resolution, listener setup, source/module loading, managed configuration validation, and import-spool housekeeping may read or write the database. They are not task delivery, and this is not a universal no-write mode. External adapter module imports remain executable trusted application code and must be qualified in the composed image. All application writers must be stopped for backup/migration regardless of this barrier.

## Required qualification

Unit and service tests cover invalid settings, same-boot single-use release, rejected guards, authorization, HTTP and websocket gates, deferred index recovery and direct business entrypoints. Real PostgreSQL tests verify a persisted pending Board request keeps its attempts/state unchanged while held and is delivered once after release. Existing normal startup and service regressions must remain green.

Before deployment, rehearse the composed image against an isolated restored database with queued heartbeats, due routines, protocol effects, tool deliveries, email/chat work and plugin jobs. Observe zero business/provider dispatch while held; reject stale/wrong-boot permits and forced guard failure; release the same observed boot and verify durable work resumes. Native independent review and exact-head CI remain required. No production readiness or cutover approval follows from unit tests alone.

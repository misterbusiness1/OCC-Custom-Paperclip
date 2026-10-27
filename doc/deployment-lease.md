# Deployment lease protocol v1

Deployment tooling must reserve the instance before draining or replacing it.
The admin-only `/api/instance/deployment-lease` API stores ownership in the private
`instance_settings` singleton `deployment-drain/v1`. It does not alter public
instance settings and needs no schema migration. Normal agent APIs cannot acquire
or mutate this lease.

GET returns the current server `bootId`, lease `generation`, owner boot, expiry
and durable drain state. It never returns a capability or capability hash.
POST acquires ownership using `expectedBootId`, `expectedLeaseGeneration`, and
`ttlMs` (positive, at most 24 hours). The response includes `ownerToken` once.
Persist it privately before proceeding. A lost acquisition response must not be
replayed: inspect status, and use explicit expired takeover if recovery is needed.

All later owner operations carry this permit:

```json
{
  "ownerToken": "<private 64-character capability>",
  "expectedLeaseGeneration": 1,
  "expectedBootId": "<current server boot UUID>"
}
```

Each successful mutation advances the lease generation. Use the returned
generation, not a cached earlier permit. Owner token, boot and generation are
checked under a row lock using the database clock. Mutation state and all company
audit rows commit together. Audit and HTTP failure logs exclude the capability.

- `POST .../renew` adds `ttlMs` and extends ownership.
- `POST .../adopt` adds `expectedOwnerBootId`; the same capability adopts a
  replacement boot while preserving its drain. Stale boot permits cannot mutate.
- `POST /api/instance/task-drain` carries `{ "deploymentLease": <permit> }`.
  Omit `ttlMs` or set it to null. Owned drains never expire automatically.
- `POST /api/startup-work-barrier/release` carries the qualified existing boot,
  protocol and controls fields plus `deploymentLease`. It requires an active
  owned drain and holds the owner row lock through the final startup barrier CAS.
- `DELETE /api/instance/task-drain` carries the same envelope with a current
  permit and clears the durable drain.
- `DELETE /api/instance/deployment-lease` carries the permit directly and refuses
  to drop ownership while its drain remains active.

Expiry does **not** resume admission, drop ownership, or enable tokenless legacy
drain changes. Expired recovery requires a new acquisition with exact current
generation and `takeOverExpired: true`. It gets a new capability and preserves
any durable drain. An old owner cannot clear the successor's state.

Ordinary unowned maintenance drains remain compatible only while no deployment
lease exists. They remain process-local. They cannot replace or clear an owned
drain, including an expired one. Use the owned protocol for deployment assurance.

## Cutover from a server without this protocol

Hold an exclusive operator window, use the old server's bounded drain, then
replace it with the new image configured to start held. Startup hold protects the
bridge because the old server cannot issue a new-protocol lease. On the held new
boot, acquire ownership, start its durable drain, qualify the exact candidate,
release startup with the permit, clear the drain with the next permit, then
release ownership. Never replay an uncertain startup release; read back the exact
boot/generation and retained qualification digest.

## Subsequent deployments

Acquire on the old new-protocol server, start its owned drain, wait for in-process
quiescence, replace with a held candidate, adopt into the new boot, qualify,
release startup, clear the drain, then release ownership. Quiescent counts remain
process-local; they do not certify database or external-provider quiescence.

`scripts/deployment-lease-client.py` provides an injected-authentication operator
client with a private 0700 journal. It uses exclusive 0600 intents/receipts and
blocks subsequent mutations after an ambiguous result. Its public result omits
the capability. It is intentionally not an automatic retry or recovery tool.

The client rejects non-regular, linked, oversized, invalid and shared journal
files before reading them; a competing local writer receives a bounded busy
error. A pending intent prevents any later mutation. If startup release may have
completed but its read-back was lost, call
`reconcile_startup_release(expected_boot_id=..., qualification=...)`. This sends
GET requests only. It requires the exact original request digest, released boot
and startup generation, qualification digest, recovery phase `ready`, and the
same unexpired owner generation with its drain still active. It records a private
acknowledgement without replaying POST or clearing the drain. A different boot,
pending recovery or different owner leaves the intent unresolved. Other ambiguous
operations require a separately reviewed read-back/recovery procedure; do not
delete a pending intent merely to retry. An acquisition whose capability response
was lost cannot recover that secret through GET: retain its packet and qualify
explicit expired takeover in a new private packet.

The ownership state persists through application rollback. A rollback to an
image without this protocol must start held and preserve the durable row. Keep
exclusive operator coordination; the old image cannot enforce or clear the new
lease. Do not release old startup without a separately reviewed rollback plan.

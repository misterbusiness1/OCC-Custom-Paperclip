# TypeSafe skill suggestion

This private OCC plugin preserves the qualified shadow observation lane and adds a separately gated active advisory lane. TypeSafe/Jev chooses at most one ID from the current installed company skill catalog. Deterministic Paperclip code validates tenant, catalog membership, typed finite output, thresholds, and fresh revisions before appending a fixed sanitized advisory block to the adapter turn context.

## Enablement

Both host and plugin gates are required:

- Shadow: `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_SHADOW=true` plus plugin `enabled=true`.
- Active advisory: `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE=true` plus plugin `enabled=true` and `activeEnabled=true`.
- `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_PLUGIN_ID` must name the running plugin installation.
- `apiKeyRef` must be a managed `secret_ref`.

The active lane is default-disabled. Explicitly selected and mandatory skills suppress advisory injection. The model never controls permissions, company ownership, blockers, approvals, execution, tool access, or model routing.

Request and cache identity include company, managed binding and resolved secret-version revisions, plugin config revision, installed catalog revision, normalized-request fingerprint, question/contract version, and model. Secret/config metadata is re-read in the worker and the catalog is re-read in the host before a result is consumed. Timeout, rate limit, permission denial, malformed/non-finite output, stale revision, catalog mismatch, or exhausted bounded retries fail open to no advisory.

## Telemetry and rollback

Run telemetry preserves the existing `skill.suggestion.shadow` and terminal load-attribution events. Payloads contain only controlled IDs, probabilities, confidence, version identifiers, latency, token counts, outcome/error class, and cache state—never prompt text, raw customer content, secrets, resolved values, or skill bodies.

Rollback is immediate and requires no migration: unset `PAPERCLIP_TYPESAFE_SKILL_SUGGESTION_ACTIVE` or set `activeEnabled=false`. Disable all calls by unsetting both host flags or setting plugin `enabled=false`.

## Operator transport policy

The bundled worker receives a dedicated host transport profile. Production uses
`https://api.typesafe.ai` with platform TLS roots. The server resolves and checks
its DNS addresses before spawning the worker. The plugin pins those addresses,
checks TLS identity, and permits only `POST /v1/systemone` on that exact origin.
It refuses redirects. Both suggestion and issue classification use this path.
Company configuration cannot select endpoints, CA files, or environment values.
Ambient `TYPESAFE_BASE_URL`, `NODE_EXTRA_CA_CERTS`, and TLS bypass variables are
not delivered to this worker.

For isolated operator qualification only, set all four deployment variables:

- `PAPERCLIP_TYPESAFE_TRANSPORT_MODE=isolated_qualification`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_TYPESAFE_TRANSPORT_PROFILE=/etc/paperclip/typesafe-transport/fixture.json`
- `PAPERCLIP_TYPESAFE_QUALIFICATION_FIXTURE={"origin":"https://typesafe-fixture.example","address":"172.30.0.3"}`

The root-owned profile JSON has exactly `baseURL` and optional `caBundlePath`:

```json
{"baseURL":"https://typesafe-fixture.example","caBundlePath":"/etc/paperclip/typesafe-transport/fixture-ca.pem"}
```

Use a root-owned, read-only mounted directory and regular files with no group or
other write permission. The path and each component must not be a symlink. CA
files must be inside that directory, at most 64 KiB, and contain only currently
valid PEM CA certificates. The loader reads the public trust material before
worker spawn; it never sends CA paths or private keys to the worker. Only the
exact bundled package path, package name, and manifest identity receive the
profile. External installations and lookalikes receive none.

The fixture policy permits one exact literal RFC1918 or public address. It does
not permit loopback, link-local, metadata, reserved ranges, URL credentials,
paths, queries, fragments, or socket URLs. It is host policy, not tenant input.
Use a separately isolated network and synthetic company credentials for tests.
Restart the server after changing operator policy. Remove all three TypeSafe
operator variables to restore the official origin and platform trust. Changing
this policy does not enable the plugin or its active advisory gates.

The qualification lane exists to prove installed-worker transport safely. It is
not evidence of a provider outage or a production TLS defect. No database
migration is required.

# Assigned OneCLI credentials in managed workers

This feature is opt-in and does not migrate existing local agents. It requires
OneCLI's authenticated `GET /v1/agent-identity` endpoint and a qualified native
Kubernetes worker deployment. Neither prerequisite is provisioned by this change.

The control-plane operator sets `PAPERCLIP_ONECLI_MANAGED_ENVIRONMENT_ID` to the
exact approved environment ID and `PAPERCLIP_ONECLI_TRUSTED_API_BASE` to the pinned
HTTPS OneCLI origin. These settings are server configuration; adapter, project,
routine and environment variables cannot select the verification destination.
Every execution in that opted-in environment requires its own verified binding.
The server and native Kubernetes plugin must be released together. A trusted typed
acquire hint is derived from that server setting, never from adapter/workspace
settings. For those acquisitions the native provider rejects any nonempty
`defaultEnv`/`envKeys` host projection before constructing a Kubernetes client or
creating a namespace, workload or secret. Move authorized model authentication and
routing into existing per-command run bindings; the provider still creates its
native per-run bootstrap/network values. Nonmanaged bootstrap remains unchanged.
Legacy reusable leases lacking the managed bootstrap marker are rejected and need
an owner-reviewed replacement; the feature does not silently destroy them.
A missing binding, foreign identity, local/SSH target, missing lease, failed
verification or low-trust review blocks dispatch with the existing owner-action
`configuration_incomplete` recovery classification. Do not enable this setting until
the deployment and subscription authentication have been qualified.

A company **owner** stores the existing assigned agent's `aoc_` credential in an
active company-scoped `local_encrypted`, `paperclip_managed` secret. No new token,
agent, grant copy, lease entity or broker is created. Its `providerMetadata` has
one reserved entry, `paperclipOnecliIdentity`, with exactly these fields:

```json
{
  "version": 1,
  "companyId": "<Paperclip company ID>",
  "agentId": "<Paperclip agent ID>",
  "environmentId": "<approved environment ID>",
  "id": "<OneCLI agent ID>",
  "identifier": "<OneCLI agent identifier>",
  "projectId": "<OneCLI project ID>",
  "organizationId": "<OneCLI organization ID>"
}
```

The owner uses `POST /api/secrets/:id/onecli-assignment` to create or replace the
required `access.paperclip_onecli_identity` agent binding. Membership is checked
inside the secret service; generic board/config permissions, agent proposals,
connection grants and config binding synchronization cannot create that binding
or expose a canonical credential under another alias. Generic binding replacement
preserves this owner assignment. Owner-only rotation, metadata changes and deletion
are supported through the normal secret routes. There is no agent-accessible raw
read path for this credential.

At dispatch, the actual realized Kubernetes target and running run must match the
recorded company, agent, environment and lease before a credential is read. The
existing durable lease must independently be active, owned by that exact company,
agent and heartbeat run, use Kubernetes, and contain the native bootstrap policy
marker. The lease is rechecked after verification alongside the run and assignment. The
self-identity response must match all four OneCLI identity fields. Credential
resolution pins the immutable numeric version captured from the verified secret;
the final assignment read requires that version to remain latest. A rotation while
HTTP verification is pending refuses projection rather than installing the old token. Redirects,
non-200 responses, unbounded bodies and administrative credentials are rejected.
The run and assignment are read again after verification to catch revocation or
reassignment during the request. These checks do not claim atomicity against an
owner editing settings after that final read; operational changes should drain the
affected runs.

Lower-trust `ONECLI_*` selectors are scrubbed before ordinary secret resolution.
The verified token and API host use the existing trusted env projection and secret
redaction paths. A server-owned names-only target policy filters inherited
control-plane values from native adapter probes, shell commands and launch envs,
while preserving explicitly resolved subscription credentials and run tokens. Codex,
Claude and OpenCode accounting use this same managed-target environment boundary,
so inherited API keys, Bedrock selectors and OpenRouter routing cannot mislabel a
subscription worker after those values were removed from its launch environment.
Explicitly bound settings and nonmanaged accounting keep their existing behavior.
The existing Kubernetes provider sends the resulting `params.env` to the in-pod
process; no second worker or env transport is introduced.

Worker teardown removes credential visibility; it does **not** revoke this
long-lived canonical token. The worker must not expose another agent's files,
operator HOME, administrative tokens, host mounts or an unscoped owner CLI login.
A legitimate assigned cluster operator, worker isolation qualification and real
model subscription checks remain release gates. Mocked seam tests do not prove
those runtime properties. Recheck the actual deployed Paperclip source/image
before merging or deploying this branch, which starts at recorded source
`63d9c0955970f0dfb769aa44cc01ec0dc5e4db8c`.

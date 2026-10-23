# OCC isolated staging lane

This lane runs a Paperclip commit as an isolated Compose project. It does not use the WordPress staging host or any production Paperclip volume.

## Isolation contract

- The project, network, database volume, runtime volume, ports, and secrets have staging-only names.
- Both services use only the staging network. Docker resolves local service names, but external DNS forwarding is disabled. First-party telemetry is disabled in this synthetic lane.
- Before qualification, the operator must enforce and attest a staging-bridge egress guard. DNS settings alone do not block numeric destinations. Prove loopback access, local database access, and refusal of off-host numeric connections and external DNS on the installed runtime. This does not claim host-service isolation.
- The HTTP port binds to `127.0.0.1`. Browser QA must use an operator-approved private tunnel to that loopback endpoint.
- The stack mounts only two host secret files. It does not mount agent homes, OneCLI data, GitHub data, WooCommerce data, customer data, or production Paperclip data.
- The bootstrap creates one synthetic admin account in the new staging database. It does not clone production data.
- The image tag is the full git SHA. The image also records that SHA in the build metadata.
- All three scripts accept only the exact `occ-paperclip-staging` project, the exact `/run/occ-paperclip-staging` resolved secret directory, and `http://127.0.0.1:<configured-port>`. They also require a non-empty, different production project identity before any Docker or HTTP mutation.

## Reviewed host command packet

Run these commands only on the existing approved Paperclip control-plane host after this change is reviewed. The isolated Compose project runs beside production on that host; it must not run on either WordPress/Sevalla host. Use a managed secret directory outside the repository, owned by the deploy user with directory mode `0700` and both files mode `0600`. The files must contain new staging-only random values.

```sh
export PAPERCLIP_STAGING_COMMIT=<reviewed-full-git-sha>
export PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging
export PAPERCLIP_PRODUCTION_PROJECT=<exact-production-compose-project>
export PAPERCLIP_STAGING_PORT=3310
export PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310
export PAPERCLIP_STAGING_SECRET_DIR=/run/occ-paperclip-staging
install -d -m 0700 /run/occ-paperclip-staging
# Provision better-auth-secret and postgres-password through the approved
# managed-secret mechanism, then chmod 0600 both files before continuing.
./scripts/staging-paperclip-deploy.sh

export PAPERCLIP_STAGING_ADMIN_PASSWORD=<runtime-only-synthetic-password>
./scripts/staging-paperclip-bootstrap.sh
```

Signup is disabled by default. Bootstrap installs an EXIT fail-safe before briefly enabling it for the first synthetic account, then force-recreates only the staging server with `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`. It uses a unique valid second address and requires the explicit HTTP 403 signup-disabled response contract; a duplicate/validation response cannot pass. The original authenticated session must remain valid.

Give Browser QA the explicit private tunnel endpoint that maps to `127.0.0.1:3310`. Do not expose the port on a public interface.

## Rollback and teardown

To roll back, check out the prior reviewed SHA and run the deploy packet again with that full SHA. The receipt records the previous and new image identity. To stop the lane without deleting its isolated data, run:

```sh
export PAPERCLIP_STAGING_SECRET_DIR=/run/occ-paperclip-staging
export PAPERCLIP_PRODUCTION_PROJECT=<exact-production-compose-project>
./scripts/staging-paperclip-teardown.sh
```

Set `PAPERCLIP_STAGING_DELETE_DATA=true` only when the staging database and runtime volume must be deleted. This action cannot affect production volumes because the script names the two staging volumes exactly.

The image is built before rollback becomes required, so build failure records `rollback: "not-required"` and cannot disturb a healthy prior stack. Before replacing an existing staging container, deploy boundedly stops the isolated stack, archives both now-quiescent volumes with the captured immutable prior image (never a pullable helper), and records that image identity. Receipt and backup directories are owner-only, archives are mode `0600`, and predeploy backups older than seven days are removed. A later failed start, production-identity comparison, or bounded health check triggers teardown, volume restoration, and restart directly from the captured immutable image ID—never a retag bearing the failed commit. If restoration fails, the stack is left down. The adjacent `.failed.json` receipt contains only commit/project, failed-step, and rollback outcome—never secret or data values. A successful receipt is promotion evidence; a failed receipt is not.

#!/usr/bin/env bash
# shellcheck disable=SC2016 # Compose interpolation tokens are matched literally.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
compose="$repo_root/docker/staging/compose.yml"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-staging-contract.XXXXXX")"
test_dir="$(cd "$test_dir" && pwd -P)"
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/secrets"
touch "$test_dir/calls"

for command in docker curl; do
  cat >"$test_dir/bin/$command" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$(basename "$0") $*" >>"$STAGING_TEST_CALLS"
exit 97
MOCK
  chmod +x "$test_dir/bin/$command"
done

assert_rejected_without_mutation() {
  local script="$1"
  shift
  : >"$test_dir/calls"
  if timeout 5 env PATH="$test_dir/bin:$PATH" STAGING_TEST_CALLS="$test_dir/calls" "$@" bash "$repo_root/scripts/$script" >/dev/null 2>&1; then
    echo "expected rejection: $script" >&2
    exit 1
  fi
  [[ ! -s "$test_dir/calls" ]] || { echo "rejected input invoked Docker/curl: $script" >&2; cat "$test_dir/calls" >&2; exit 1; }
}

grep -q '127.0.0.1:${PAPERCLIP_STAGING_PORT' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_db' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_runtime' "$compose"
grep -q '${PAPERCLIP_STAGING_PROJECT}_network' "$compose"
grep -q 'PAPERCLIP_DEPLOYMENT_MODE: authenticated' "$compose"
grep -q 'pull_policy: never' "$compose"
grep -q 'pgvector/pgvector:pg16' "$compose"
grep -q 'PAPERCLIP_AUTH_DISABLE_SIGN_UP:' "$compose"
if grep -q '/usr/local/bin/docker-entrypoint.sh' "$compose"; then echo 'unexpected entrypoint override' >&2; exit 1; fi
grep -qx 'staging-receipts' "$repo_root/.dockerignore"
grep -qx 'staging-receipts/' "$repo_root/.gitignore"
grep -q 'resources:' "$compose"
grep -q 'healthcheck:' "$compose"
if grep -Eq '(/paperclip/instances/default|onecli|\.config/gh|woocommerce|customer|production.*volume)' "$compose"; then echo 'sensitive production path in staging Compose' >&2; exit 1; fi
bash -n "$repo_root/scripts/staging-paperclip-deploy.sh"
bash -n "$repo_root/scripts/staging-paperclip-bootstrap.sh"
bash -n "$repo_root/scripts/staging-paperclip-teardown.sh"

# Render the effective model with value-free fixture paths. This proves the
# project/resource names, loopback port, pull policy, limits, and auth flag as
# Compose interprets them rather than merely grepping source YAML.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  rendered="$(PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging \
    PAPERCLIP_STAGING_IMAGE=ghcr.io/oxfordcigar/paperclip:0000000000000000000000000000000000000000 \
    PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets" \
    PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310 \
    PAPERCLIP_STAGING_AUTH_DISABLE_SIGN_UP=true \
    docker compose -f "$compose" config --format json)"
  jq -e '
    .name == "occ-paperclip-staging" and
    .services.server.pull_policy == "never" and
    .services.server.dns == ["127.0.0.1"] and
    .services.db.dns == ["127.0.0.1"] and
    .services.server.environment.PAPERCLIP_TELEMETRY_DISABLED == "1" and
    (.services.server.networks | keys) == ["staging"] and
    (.services.db.networks | keys) == ["staging"] and
    .services.server.environment.PAPERCLIP_AUTH_DISABLE_SIGN_UP == "true" and
    .services.server.ports[0].host_ip == "127.0.0.1" and
    .services.server.deploy.resources.limits.memory == "3221225472" and
    .services.db.image == "pgvector/pgvector:pg16" and
    .volumes["staging-db"].name == "occ-paperclip-staging_db" and
    .networks.staging.name == "occ-paperclip-staging_network"
  ' >/dev/null <<<"$rendered"
else
  echo 'staging Paperclip Compose render: SKIP (Docker Compose unavailable)'
fi

common=(
  PAPERCLIP_STAGING_COMMIT="$(git -C "$repo_root" rev-parse HEAD)"
  PAPERCLIP_PRODUCTION_PROJECT=paperclip
  PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging
  PAPERCLIP_STAGING_PORT=3310
  PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310
  PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets"
  PAPERCLIP_STAGING_ADMIN_PASSWORD=synthetic-test-only
)

assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_PRODUCTION_PROJECT=dummy-production
assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=paperclip
assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=bad-staging-name
assert_rejected_without_mutation staging-paperclip-deploy.sh "${common[@]}" PAPERCLIP_STAGING_RECEIPT_DIR="$test_dir/unapproved-receipts"
assert_rejected_without_mutation staging-paperclip-bootstrap.sh "${common[@]}" PAPERCLIP_STAGING_PUBLIC_URL=https://production.example.test
assert_rejected_without_mutation staging-paperclip-bootstrap.sh "${common[@]}" PAPERCLIP_STAGING_SECRET_DIR="$test_dir/secrets/../secrets"
assert_rejected_without_mutation staging-paperclip-teardown.sh "${common[@]}" PAPERCLIP_STAGING_PROJECT=paperclip

# Exercise the failure trap with a valid preflight and a prior staging stack.
# Each adversarial case must reach mutation, stay staging-scoped, restore the
# prior image/data, and leave a machine-readable, value-free terminal receipt.
fixture="$test_dir/repo"
mkdir -p "$fixture/scripts/lib" "$fixture/docker/staging" "$fixture/secrets" "$fixture/staging-receipts"
cp "$repo_root/scripts/staging-paperclip-deploy.sh" "$fixture/scripts/"
cp "$repo_root/scripts/staging-paperclip-bootstrap.sh" "$fixture/scripts/"
cp "$repo_root/scripts/lib/staging-paperclip-guard.sh" "$fixture/scripts/lib/"
cp "$compose" "$fixture/docker/staging/compose.yml"
sed "s#PAPERCLIP_APPROVED_STAGING_SECRET_DIR=\"/run/occ-paperclip-staging\"#PAPERCLIP_APPROVED_STAGING_SECRET_DIR=\"$fixture/secrets\"#" \
  "$fixture/scripts/lib/staging-paperclip-guard.sh" >"$fixture/scripts/lib/staging-paperclip-guard.sh.tmp"
mv "$fixture/scripts/lib/staging-paperclip-guard.sh.tmp" "$fixture/scripts/lib/staging-paperclip-guard.sh"
printf 'fixture\n' >"$fixture/secrets/better-auth-secret"
printf 'fixture\n' >"$fixture/secrets/postgres-password"
chmod 700 "$fixture/secrets"
chmod 600 "$fixture/secrets/"*
git -C "$fixture" init -q
git -C "$fixture" config user.email test@example.test
git -C "$fixture" config user.name 'Contract Test'
git -C "$fixture" add .
git -C "$fixture" commit -qm fixture
fixture_commit="$(git -C "$fixture" rev-parse HEAD)"

cat >"$test_dir/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$STAGING_TEST_CALLS"
prior_digest="1111111111111111111111111111111111111111111111111111111111111111"
prior_image_id="sha256:$prior_digest"
backup_mount=""
for argument in "$@"; do
  case "$argument" in *:/backup|*:/backup:ro) backup_mount="${argument%%:/backup*}" ;; esac
done
if [[ "${1:-}" == run && ( "$*" == *":/source:ro"* || "$*" == *":/restore"* ) ]]; then
  [[ " $* " == *" $prior_image_id "* ]] || exit 98
fi
if [[ "$*" == *' exec -T server bash -euc '* ]]; then
  [[ "$*" == *'cat /run/secrets/postgres_password'* ]] || exit 96
  printf 'Invite URL: http://127.0.0.1:3310/invite/pcp_bootstrap_fixture\n'
  exit
fi
case "$*" in
  'ps --all --filter label=com.docker.compose.project=paperclip --format {{.ID}}') printf 'prod-1\n' ;;
  'inspect prod-1 --format {{.Id}} {{.Image}}')
    [[ "${STAGING_TEST_SCENARIO:-}" == identity-mismatch && -f "$STAGING_TEST_STATE/started" ]] && printf 'prod-2 image-prod\n' || printf 'prod-1 image-prod\n'
    ;;
  *' config --format json') jq -n --arg p occ-paperclip-staging '{name:$p,volumes:{"staging-db":{name:($p+"_db")},"staging-runtime":{name:($p+"_runtime")}},networks:{staging:{name:($p+"_network")}}}' ;;
  *' images -q server') [[ "${STAGING_TEST_SCENARIO:-}" == first-deploy ]] || printf '%s\n' "$prior_digest" ;;
  *' ps -a -q db') [[ "${STAGING_TEST_SCENARIO:-}" == first-deploy || "${STAGING_TEST_SCENARIO:-}" == orphan-runtime || "${STAGING_TEST_SCENARIO:-}" == orphan-container ]] || printf 'staging-db\n' ;;
  *' ps -a -q server') [[ "${STAGING_TEST_SCENARIO:-}" == first-deploy || "${STAGING_TEST_SCENARIO:-}" == orphan-db ]] || printf 'staging-server\n' ;;
  'ps --all --filter label=com.docker.compose.project=occ-paperclip-staging --format {{.ID}}') printf 'staging-server\n' ;;
  'inspect --format {{index .Config.Labels "com.docker.compose.service"}} staging-server') printf 'server\n' ;;
  'volume inspect occ-paperclip-staging_db') [[ "${STAGING_TEST_SCENARIO:-}" == first-deploy || "${STAGING_TEST_SCENARIO:-}" == orphan-runtime || "${STAGING_TEST_SCENARIO:-}" == orphan-container ]] && exit 1 || exit 0 ;;
  'volume inspect occ-paperclip-staging_runtime') [[ "${STAGING_TEST_SCENARIO:-}" == first-deploy || "${STAGING_TEST_SCENARIO:-}" == orphan-db || "${STAGING_TEST_SCENARIO:-}" == orphan-container ]] && exit 1 || exit 0 ;;
  'network inspect occ-paperclip-staging_network') [[ "${STAGING_TEST_SCENARIO:-}" == first-deploy || "${STAGING_TEST_SCENARIO:-}" == orphan-container ]] && exit 1 || exit 0 ;;
  'volume inspect --format {{index .Labels "com.docker.compose.project"}} occ-paperclip-staging_db'|'volume inspect --format {{index .Labels "com.docker.compose.project"}} occ-paperclip-staging_runtime'|'network inspect --format {{index .Labels "com.docker.compose.project"}} occ-paperclip-staging_network') printf 'occ-paperclip-staging\n' ;;
  "image inspect $prior_digest --format {{.Id}}") printf '%s\n' "$prior_image_id" ;;
  run*':/source:ro'*db.tgz*)
    [[ "${STAGING_TEST_SCENARIO:-}" == first-backup-failure ]] && exit 1
    printf 'db-backup-%s' "${STAGING_TEST_ATTEMPT:-one}" >"$backup_mount/.db-marker"
    tar -czf "$backup_mount/db.tgz" -C "$backup_mount" .db-marker
    rm "$backup_mount/.db-marker"
    ;;
  run*':/source:ro'*runtime.tgz*)
    [[ "${STAGING_TEST_SCENARIO:-}" == second-backup-failure ]] && exit 1
    printf 'runtime-backup-%s' "${STAGING_TEST_ATTEMPT:-one}" >"$backup_mount/.runtime-marker"
    tar -czf "$backup_mount/runtime.tgz" -C "$backup_mount" .runtime-marker
    rm "$backup_mount/.runtime-marker"
    ;;
  'image inspect ghcr.io/oxfordcigar/paperclip:'*' --format {{.Id}}') printf 'new-image\n' ;;
  'image inspect ghcr.io/oxfordcigar/paperclip:'*' --format {{index .Config.Labels "org.opencontainers.image.revision"}}') printf '%s\n' "$STAGING_TEST_COMMIT" ;;
  compose*' up -d --wait') : >"$STAGING_TEST_STATE/started" ;;
esac
MOCK
cat >"$test_dir/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$STAGING_TEST_CALLS"
if [[ "${STAGING_TEST_SCENARIO:-}" == bootstrap-signup-open ]]; then
  output=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == --output ]]; then output="$argument"; break; fi
    previous="$argument"
  done
  case "$*" in
    *'/api/auth/sign-up/email'*)
      [[ -z "$output" ]] || printf '{"status":"unexpected-open"}\n' >"$output"
      printf '200'
      ;;
    *'/api/auth/get-session'*) printf '{"user":{"id":"fixture-user"}}\n' ;;
    *'/api/companies'*) printf '[]\n' ;;
    *'/api/health'*) printf '{"status":"ok","bootstrapStatus":"ready"}\n' ;;
    *) exit 1 ;;
  esac
  exit
fi
if [[ "${STAGING_TEST_SCENARIO:-}" == bootstrap-cli-env ]]; then
  output=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == --output ]]; then output="$argument"; break; fi
    previous="$argument"
  done
  case "$*" in
    *'/api/auth/sign-up/email'*)
      if [[ "$output" == *second-signup.json ]]; then
        printf '{"code":"SIGN_UP_DISABLED"}\n' >"$output"
        printf '400'
      else
        printf '{}\n' >"$output"
        printf '200'
      fi
      ;;
    *'/api/invites/pcp_bootstrap_fixture/accept'*) printf '{}\n' >"$output"; printf '200' ;;
    *'/api/auth/get-session'*) printf '{"user":{"id":"fixture-user"}}\n' ;;
    *'/api/companies'*) printf '[]\n' ;;
    *'/api/health'*) printf '{"status":"ok","bootstrapStatus":"bootstrap_pending"}\n' ;;
    *) exit 1 ;;
  esac
  exit
fi
[[ "${STAGING_TEST_SCENARIO:-}" == health-failure ]] && printf '{"status":"bad"}\n' || printf '{"status":"ok"}\n'
MOCK
cat >"$test_dir/bin/timeout" <<'MOCK'
#!/usr/bin/env bash
seconds="$1"; shift
printf 'timeout %s %s\n' "$seconds" "$*" >>"$STAGING_TEST_CALLS"
case "${STAGING_TEST_SCENARIO:-}:$*" in
  build-timeout:'docker build '*) exit 124 ;;
  stop-failure:'docker compose '*' stop') exit 1 ;;
  start-timeout:'docker compose '*' up -d --wait')
    if [[ ! -f "$STAGING_TEST_STATE/start-failed" ]]; then : >"$STAGING_TEST_STATE/start-failed"; exit 124; fi
    ;;
esac
"$@"
MOCK
chmod +x "$test_dir/bin/docker" "$test_dir/bin/curl" "$test_dir/bin/timeout"

assert_failed_deploy() {
  local scenario="$1" receipt="$fixture/staging-receipts/$fixture_commit.failed.json"
  rm -f "$receipt" "$test_dir/started" "$test_dir/start-failed"
  : >"$test_dir/calls"
  if env PATH="$test_dir/bin:$PATH" STAGING_TEST_CALLS="$test_dir/calls" \
    STAGING_TEST_SCENARIO="$scenario" STAGING_TEST_STATE="$test_dir" \
    STAGING_TEST_COMMIT="$fixture_commit" PAPERCLIP_STAGING_COMMIT="$fixture_commit" \
    PAPERCLIP_PRODUCTION_PROJECT=paperclip PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging \
    PAPERCLIP_STAGING_PORT=3310 PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310 \
    PAPERCLIP_STAGING_SECRET_DIR="$fixture/secrets" PAPERCLIP_STAGING_RECEIPT_DIR="$fixture/staging-receipts" \
    PAPERCLIP_STAGING_BUILD_TIMEOUT_SECONDS=60 PAPERCLIP_STAGING_START_TIMEOUT_SECONDS=30 \
    bash "$fixture/scripts/staging-paperclip-deploy.sh" >/dev/null 2>&1; then
    echo "expected deploy failure: $scenario" >&2; exit 1
  fi
  if [[ "$scenario" == build-timeout ]]; then
    jq -e --arg c "$fixture_commit" '.status=="failed" and .commit==$c and .rollback=="not-required" and (keys|sort)==["commit","composeProject","failedStep","rollback","status"]' "$receipt" >/dev/null
    if grep -Eq 'compose .* (stop|down|up)' "$test_dir/calls"; then echo 'build failure mutated staging' >&2; exit 1; fi
    return
  fi
  if [[ "$scenario" == stop-failure || "$scenario" == first-backup-failure || "$scenario" == second-backup-failure ]]; then
    jq -e --arg c "$fixture_commit" '.status=="failed" and .commit==$c and .rollback=="prior-stack-restarted-untouched"' "$receipt" >/dev/null
    if grep -q 'down --remove-orphans' "$test_dir/calls"; then echo 'untouched prior stack was torn down' >&2; exit 1; fi
    if grep -q ':/restore' "$test_dir/calls"; then echo 'untouched prior data was restored' >&2; exit 1; fi
    grep -q 'timeout 180 docker compose -p occ-paperclip-staging .* up -d --wait' "$test_dir/calls"
    return
  fi
  jq -e --arg c "$fixture_commit" '.status=="failed" and .commit==$c and .composeProject=="occ-paperclip-staging" and (.failedStep|test("^line-[0-9]+$")) and .rollback=="prior-image-and-data-restored" and (keys|sort)==["commit","composeProject","failedStep","rollback","status"]' "$receipt" >/dev/null
  if grep -q 'compose -p paper .*\(down\|up\|build\|run\|tag\)' "$test_dir/calls"; then echo 'production Compose mutation attempted' >&2; exit 1; fi
  stop_line="$(awk '/compose -p occ-paperclip-staging .* stop$/{print NR; exit}' "$test_dir/calls")"
  backup_line="$(awk '/run --pull never .*:\/source:ro/{print NR; exit}' "$test_dir/calls")"
  failed_up_line="$(awk '/compose -p occ-paperclip-staging .* up -d --wait/{print NR; exit}' "$test_dir/calls")"
  down_line="$(awk '/compose -p occ-paperclip-staging .* down --remove-orphans/{print NR; exit}' "$test_dir/calls")"
  restore_line="$(awk '/run --pull never .*:\/restore/{print NR; exit}' "$test_dir/calls")"
  restart_line="$(awk '/compose -p occ-paperclip-staging .* up -d --wait/{line=NR} END{print line}' "$test_dir/calls")"
  (( stop_line < backup_line && backup_line < failed_up_line && failed_up_line < down_line && down_line < restore_line && restore_line < restart_line ))
  grep -q 'timeout 120 docker compose -p occ-paperclip-staging .* down --remove-orphans' "$test_dir/calls"
  if grep -q 'docker image tag prior-image' "$test_dir/calls"; then echo 'prior image was retagged' >&2; exit 1; fi
  grep -q 'timeout 180 docker compose -p occ-paperclip-staging .* up -d --wait' "$test_dir/calls"
}

assert_failed_deploy build-timeout
assert_failed_deploy stop-failure
assert_failed_deploy first-backup-failure
assert_failed_deploy second-backup-failure
assert_failed_deploy start-timeout
backup_owner="$(id -u):$(id -g)"
[[ "$(awk -v marker="chown $backup_owner /backup/" 'index($0,"docker run --pull never")==1 && index($0,marker){count++} END{print count+0}' "$test_dir/calls")" -eq 2 ]]
assert_failed_deploy identity-mismatch
assert_failed_deploy health-failure

# A bootstrap that cannot prove signup is closed must stop the staging server.
: >"$test_dir/calls"
if env PATH="$test_dir/bin:$PATH" STAGING_TEST_CALLS="$test_dir/calls" \
  STAGING_TEST_SCENARIO=bootstrap-signup-open STAGING_TEST_STATE="$test_dir" \
  PAPERCLIP_PRODUCTION_PROJECT=paperclip PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging \
  PAPERCLIP_STAGING_PORT=3310 PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310 \
  PAPERCLIP_STAGING_SECRET_DIR="$fixture/secrets" PAPERCLIP_STAGING_ADMIN_PASSWORD=synthetic-test-only \
  bash "$fixture/scripts/staging-paperclip-bootstrap.sh" >/dev/null 2>&1; then
  echo "expected bootstrap signup proof failure" >&2; exit 1
fi
grep -q 'timeout 60 docker compose -p occ-paperclip-staging .* stop server' "$test_dir/calls"

# Environment-configured authenticated deployments load the database secret
# inside the isolated exec and complete the invite flow without config.json.
: >"$test_dir/calls"
env PATH="$test_dir/bin:$PATH" STAGING_TEST_CALLS="$test_dir/calls" \
  STAGING_TEST_SCENARIO=bootstrap-cli-env STAGING_TEST_STATE="$test_dir" \
  PAPERCLIP_PRODUCTION_PROJECT=paperclip PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging \
  PAPERCLIP_STAGING_PORT=3310 PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310 \
  PAPERCLIP_STAGING_SECRET_DIR="$fixture/secrets" PAPERCLIP_STAGING_ADMIN_PASSWORD=synthetic-test-only \
  bash "$fixture/scripts/staging-paperclip-bootstrap.sh" >/dev/null
grep -q 'exec -T server bash -euc .*cat /run/secrets/postgres_password' "$test_dir/calls"
grep -q '/api/invites/pcp_bootstrap_fixture/accept' "$test_dir/calls"

# Orphan/partial resource sets fail closed before build, stop, backup, or start.
for scenario in orphan-db orphan-runtime orphan-container; do
  : >"$test_dir/calls"
  if env PATH="$test_dir/bin:$PATH" STAGING_TEST_CALLS="$test_dir/calls" STAGING_TEST_SCENARIO="$scenario" \
    STAGING_TEST_STATE="$test_dir" STAGING_TEST_COMMIT="$fixture_commit" PAPERCLIP_STAGING_COMMIT="$fixture_commit" \
    PAPERCLIP_PRODUCTION_PROJECT=paperclip PAPERCLIP_STAGING_PROJECT=occ-paperclip-staging \
    PAPERCLIP_STAGING_PORT=3310 PAPERCLIP_STAGING_PUBLIC_URL=http://127.0.0.1:3310 \
    PAPERCLIP_STAGING_SECRET_DIR="$fixture/secrets" bash "$fixture/scripts/staging-paperclip-deploy.sh" >/dev/null 2>&1; then
    echo "expected orphan rejection: $scenario" >&2; exit 1
  fi
  if grep -Eq 'docker (build|run)|compose .* (stop|down|up)' "$test_dir/calls"; then echo "orphan check mutated staging: $scenario" >&2; exit 1; fi
done

# Same-SHA retries always receive distinct attempt directories; a partial first
# attempt can never be combined with the next attempt's archives.
first_attempt="$(mktemp -d "$fixture/staging-receipts/$fixture_commit.predeploy-data.XXXXXX")"
printf stale >"$first_attempt/db.tgz"
: >"$test_dir/calls"
STAGING_TEST_ATTEMPT=two assert_failed_deploy start-timeout
attempt_count="$(find "$fixture/staging-receipts" -mindepth 1 -maxdepth 1 -type d -name "$fixture_commit.predeploy-data.*" | wc -l | tr -d ' ')"
(( attempt_count >= 2 ))
valid_retry=false
while read -r attempt_dir; do
  [[ -s "$attempt_dir/db.tgz" && -s "$attempt_dir/runtime.tgz" ]] || continue
  if [[ "$(tar -xOzf "$attempt_dir/db.tgz" .db-marker)" == db-backup-two \
    && "$(tar -xOzf "$attempt_dir/runtime.tgz" .runtime-marker)" == runtime-backup-two ]]; then
    valid_retry=true
  fi
done < <(find "$fixture/staging-receipts" -mindepth 1 -maxdepth 1 -type d -name "$fixture_commit.predeploy-data.*")
[[ "$valid_retry" == true ]]
echo 'staging Paperclip isolation contract: PASS'

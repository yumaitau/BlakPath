#!/usr/bin/env bash
set -euo pipefail

# Same digest as docker-compose.yml and .github/workflows/ci.yml.
# `--user 0:0` on the mirror containers: this image defaults to uid 65532, and
# the backup volume is created root-owned.
object_storage_image="chainguard/minio@sha256:dc455cdd4db6e390b1b26514f15ff37681a777bf8dab41aac445a0259f751e56"

source_project="${RESTORE_SOURCE_PROJECT:-blakpath-restore-source}"
target_project="${RESTORE_TARGET_PROJECT:-blakpath-restore-target}"
backup_volume="${source_project}-backup-$$"
dump_file="${TMPDIR:-/tmp}/blakpath-restore-drill-$$.dump"
record_dir="${RESTORE_DRILL_RECORD_DIR:-tmp/restore-drills}"
started_epoch="$(date +%s)"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

source_compose() {
  BLAKPATH_POSTGRES_PORT=55451 \
    BLAKPATH_REDIS_PORT=56397 \
    BLAKPATH_MINIO_PORT=59018 \
    BLAKPATH_MINIO_CONSOLE_PORT=59019 \
    S3_ACCESS_KEY_ID=blakpath \
    S3_SECRET_ACCESS_KEY=blakpath-dev-secret \
    BLAKPATH_CLAMAV_PORT=53320 \
    BLAKPATH_SMTP_PORT=51035 \
    BLAKPATH_MAILPIT_UI_PORT=58035 \
    docker compose -p "$source_project" "$@"
}

target_compose() {
  BLAKPATH_POSTGRES_PORT=55461 \
    BLAKPATH_REDIS_PORT=56407 \
    BLAKPATH_MINIO_PORT=59028 \
    BLAKPATH_MINIO_CONSOLE_PORT=59029 \
    S3_ACCESS_KEY_ID=blakpath \
    S3_SECRET_ACCESS_KEY=blakpath-dev-secret \
    docker compose -p "$target_project" "$@"
}

cleanup() {
  exit_code=$?
  trap - EXIT INT TERM
  source_compose down -v --remove-orphans >/dev/null 2>&1 || true
  target_compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$backup_volume" >/dev/null 2>&1 || true
  rm -f "$dump_file"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

source_compose down -v --remove-orphans >/dev/null 2>&1 || true
target_compose down -v --remove-orphans >/dev/null 2>&1 || true

BLAKPATH_LIVE_PROJECT="$source_project" \
  BLAKPATH_LIVE_KEEP=1 \
  BLAKPATH_POSTGRES_PORT=55451 \
  BLAKPATH_REDIS_PORT=56397 \
  BLAKPATH_MINIO_PORT=59018 \
  BLAKPATH_MINIO_CONSOLE_PORT=59019 \
  BLAKPATH_CLAMAV_PORT=53320 \
  BLAKPATH_SMTP_PORT=51035 \
  BLAKPATH_MAILPIT_UI_PORT=58035 \
  BLAKPATH_LIVE_WEB_PORT=3028 \
  bash scripts/verify-live-stack.sh

NODE_ENV=development \
  DATABASE_URL=postgres://blakpath:blakpath@127.0.0.1:55451/blakpath \
  REDIS_URL=redis://127.0.0.1:56397 \
  BETTER_AUTH_SECRET=restore-source-secret-with-at-least-32-characters \
  ENCRYPTION_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  S3_ENDPOINT=http://127.0.0.1:59018 \
  S3_REGION=ap-southeast-2 \
  S3_ACCESS_KEY_ID=blakpath \
  S3_SECRET_ACCESS_KEY=blakpath-dev-secret \
  S3_BUCKET_EVIDENCE=blakpath-evidence \
  S3_BUCKET_QUARANTINE=blakpath-quarantine \
  S3_FORCE_PATH_STYLE=true \
  pnpm exec tsx scripts/verify-restored-data.ts >/dev/null

source_compose exec -T postgres \
  pg_dump -U blakpath -d blakpath --format=custom --no-owner >"$dump_file"
docker volume create "$backup_volume" >/dev/null
docker run --rm \
  --network "${source_project}_default" \
  -v "${backup_volume}:/backup" \
  --user 0:0 --entrypoint /bin/sh "$object_storage_image" -c '
    mkdir -p /backup/evidence /backup/quarantine &&
    mc alias set source http://minio:9000 blakpath blakpath-dev-secret >/dev/null &&
    mc mirror --overwrite source/blakpath-evidence /backup/evidence &&
    mc mirror --overwrite source/blakpath-quarantine /backup/quarantine
  '

target_compose up -d postgres redis minio minio-init
postgres_id="$(target_compose ps -q postgres)"
minio_init_id="$(target_compose ps -q minio-init)"
for _ in $(seq 1 60); do
  postgres_health="$(docker inspect --format '{{.State.Health.Status}}' "$postgres_id")"
  init_status="$(docker inspect --format '{{.State.Status}}' "$minio_init_id")"
  init_exit="$(docker inspect --format '{{.State.ExitCode}}' "$minio_init_id")"
  if [[ "$postgres_health" == healthy && "$init_status" == exited && "$init_exit" == 0 ]]; then
    break
  fi
  sleep 2
done
if [[ "${postgres_health:-}" != healthy || "${init_exit:-1}" != 0 ]]; then
  target_compose ps
  target_compose logs postgres minio minio-init
  exit 1
fi

target_compose exec -T postgres pg_restore \
  -U blakpath -d blakpath --clean --if-exists --no-owner <"$dump_file"
docker run --rm \
  --network "${target_project}_default" \
  -v "${backup_volume}:/backup:ro" \
  --user 0:0 --entrypoint /bin/sh "$object_storage_image" -c '
    mc alias set target http://minio:9000 blakpath blakpath-dev-secret >/dev/null &&
    mc mirror --overwrite /backup/evidence target/blakpath-evidence &&
    mc mirror --overwrite /backup/quarantine target/blakpath-quarantine
  '

export NODE_ENV=development
export DATABASE_URL=postgres://blakpath:blakpath@127.0.0.1:55461/blakpath
export REDIS_URL=redis://127.0.0.1:56407
export APP_URL=http://localhost:3038
export BETTER_AUTH_URL="$APP_URL"
export BETTER_AUTH_SECRET=restore-drill-only-secret-with-at-least-32-characters
export ENCRYPTION_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export S3_ENDPOINT=http://127.0.0.1:59028
export S3_REGION=ap-southeast-2
export S3_ACCESS_KEY_ID=blakpath
export S3_SECRET_ACCESS_KEY=blakpath-dev-secret
export S3_BUCKET_EVIDENCE=blakpath-evidence
export S3_BUCKET_QUARANTINE=blakpath-quarantine
export S3_FORCE_PATH_STYLE=true
export CLAMAV_HOST=127.0.0.1
export CLAMAV_PORT=53320
export SMTP_HOST=127.0.0.1
export SMTP_PORT=51035
export BLAKPATH_LIVE_WEB_PORT=3038
export LIVE_BASE_URL="$APP_URL"
export LIVE_TEST_MATCH=restored-stack.spec.ts

verification_json="$(pnpm exec tsx scripts/verify-restored-data.ts)"
pnpm exec playwright test --config playwright.live.config.ts

finished_epoch="$(date +%s)"
finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
rto_seconds="$((finished_epoch - started_epoch))"
mkdir -p "$record_dir"
record_file="${record_dir}/$(date -u +%Y%m%dT%H%M%SZ)-restore-drill.json"
cat >"$record_file" <<EOF
{
  "startedAt": "$started_at",
  "finishedAt": "$finished_at",
  "operator": "${USER:-unknown}",
  "source": "$source_project",
  "target": "$target_project",
  "rtoSeconds": $rto_seconds,
  "databaseRestore": "passed",
  "objectChecksum": "passed",
  "auditIntegrity": "passed",
  "restoredSignIn": "passed",
  "verification": $verification_json
}
EOF
echo "Restore drill passed in ${rto_seconds}s. Record: ${record_file}"

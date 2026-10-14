#!/usr/bin/env bash
set -euo pipefail

# Runs an isolated, disposable copy of every local dependency, then exercises
# the real browser, database, worker, object-storage, scanner and email paths.
project="${BLAKPATH_LIVE_PROJECT:-blakpath-live-verification}"
export BLAKPATH_POSTGRES_PORT="${BLAKPATH_POSTGRES_PORT:-55441}"
export BLAKPATH_REDIS_PORT="${BLAKPATH_REDIS_PORT:-56387}"
export BLAKPATH_MINIO_PORT="${BLAKPATH_MINIO_PORT:-59008}"
export BLAKPATH_MINIO_CONSOLE_PORT="${BLAKPATH_MINIO_CONSOLE_PORT:-59009}"
export BLAKPATH_CLAMAV_PORT="${BLAKPATH_CLAMAV_PORT:-53310}"
export BLAKPATH_SMTP_PORT="${BLAKPATH_SMTP_PORT:-51025}"
export BLAKPATH_MAILPIT_UI_PORT="${BLAKPATH_MAILPIT_UI_PORT:-58025}"
export BLAKPATH_LIVE_WEB_PORT="${BLAKPATH_LIVE_WEB_PORT:-3018}"

export NODE_ENV=development
export ALLOW_DEV_SEED=1
export APP_URL="http://localhost:${BLAKPATH_LIVE_WEB_PORT}"
export BETTER_AUTH_URL="$APP_URL"
export BETTER_AUTH_SECRET="live-stack-only-secret-with-at-least-32-characters"
export ENCRYPTION_MASTER_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
export DATABASE_URL="postgres://blakpath:blakpath@127.0.0.1:${BLAKPATH_POSTGRES_PORT}/blakpath"
export REDIS_URL="redis://127.0.0.1:${BLAKPATH_REDIS_PORT}"
export S3_ENDPOINT="http://127.0.0.1:${BLAKPATH_MINIO_PORT}"
export S3_REGION=ap-southeast-2
export S3_ACCESS_KEY_ID=blakpath
export S3_SECRET_ACCESS_KEY=blakpath-dev-secret
export S3_BUCKET_EVIDENCE=blakpath-evidence
export S3_BUCKET_QUARANTINE=blakpath-quarantine
export S3_FORCE_PATH_STYLE=true
export CLAMAV_HOST=127.0.0.1
export CLAMAV_PORT="$BLAKPATH_CLAMAV_PORT"
export SMTP_HOST=127.0.0.1
export SMTP_PORT="$BLAKPATH_SMTP_PORT"
export LIVE_BASE_URL="$APP_URL"
export LIVE_MAILPIT_URL="http://127.0.0.1:${BLAKPATH_MAILPIT_UI_PORT}"

compose=(docker compose -p "$project")
worker_pid=''
worker_log=''

cleanup() {
  exit_code=$?
  trap - EXIT INT TERM
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  if [[ "$exit_code" -ne 0 && -n "$worker_log" && -f "$worker_log" ]]; then
    echo 'Background worker log:' >&2
    tail -n 200 "$worker_log" >&2
  fi
  if [[ "${BLAKPATH_LIVE_KEEP:-0}" != 1 ]]; then
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" up -d postgres redis minio minio-init clamav mailpit

clamav_id="$("${compose[@]}" ps -q clamav)"
for _ in $(seq 1 120); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$clamav_id")"
  if [[ "$health" == healthy ]]; then
    break
  fi
  if [[ "$health" == unhealthy ]]; then
    "${compose[@]}" logs clamav
    exit 1
  fi
  sleep 5
done
if [[ "${health:-}" != healthy ]]; then
  "${compose[@]}" logs clamav
  echo 'ClamAV did not become healthy within 10 minutes.' >&2
  exit 1
fi

pnpm db:migrate
pnpm db:seed

worker_log="${TMPDIR:-/tmp}/blakpath-live-worker-$$.log"
pnpm worker >"$worker_log" 2>&1 &
worker_pid=$!
sleep 2
if ! kill -0 "$worker_pid" 2>/dev/null; then
  wait "$worker_pid"
fi

pnpm exec playwright test --config playwright.live.config.ts

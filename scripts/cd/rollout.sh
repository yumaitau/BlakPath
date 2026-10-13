#!/usr/bin/env bash
# Release gate, then migrate, then digest-pinned rollout, then smoke.
# Gate and migrate failures leave the previous workloads serving.
# Rollout and smoke failures roll the workloads back. Migrations are not reversed.
set -euo pipefail

cd "$(dirname "$0")/../.."

environment="${DEPLOY_ENVIRONMENT:?}"
namespace="${NAMESPACE:?}"
app_url="${APP_URL:?}"
web_repository="${WEB_REPOSITORY:?}"
worker_repository="${WORKER_REPOSITORY:?}"
web_digest="${WEB_DIGEST:?}"
worker_digest="${WORKER_DIGEST:?}"
run_id="${GITHUB_RUN_ID:?}"
run_attempt="${GITHUB_RUN_ATTEMPT:?}"
rollback_file="${ROLLBACK_FILE:-${RUNNER_TEMP:-/tmp}/blakpath-rollback.env}"

pnpm exec tsx scripts/cd/assert-oidc-target.ts

actual_app_url="$(kubectl -n "$namespace" get configmap blakpath-config -o jsonpath='{.data.APP_URL}')"
actual_secret_path="$(kubectl -n "$namespace" get externalsecret blakpath-runtime -o jsonpath='{.spec.dataFrom[0].extract.key}')"
pnpm exec tsx scripts/cd/assert-cluster-target.ts \
  --environment "$environment" \
  --expected-app-url "$app_url" \
  --actual-app-url "$actual_app_url" \
  --actual-secret-path "$actual_secret_path"

previous_web="$(kubectl -n "$namespace" get deploy blakpath-app -o jsonpath='{.spec.template.spec.containers[?(@.name=="web")].image}')"
previous_worker="$(kubectl -n "$namespace" get deploy blakpath-worker -o jsonpath='{.spec.template.spec.containers[?(@.name=="worker")].image}')"
pnpm exec tsx scripts/cd/assert-rollback.ts "$previous_web" "$previous_worker"
mkdir -p "$(dirname "$rollback_file")"
printf 'web=%s\nworker=%s\n' "$previous_web" "$previous_worker" >"$rollback_file"

mutated=0
on_exit() {
  local status=$?
  if ((status != 0 && mutated == 1)); then
    mutated=0
    echo "deploy failed after rollout; rolling workloads back" >&2
    ROLLBACK_FILE="$rollback_file" NAMESPACE="$namespace" bash scripts/cd/rollback.sh \
      || echo "rollback failed" >&2
  fi
  exit "$status"
}
trap on_exit EXIT

wait_for_job() {
  local name="$1"
  local timeout_seconds="$2"
  local start=$SECONDS
  while true; do
    local complete failed
    # .status.failed increments while backoffLimit still allows a retry.
    # The Job conditions are terminal.
    complete="$(kubectl -n "$namespace" get job "$name" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}')"
    failed="$(kubectl -n "$namespace" get job "$name" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}')"
    if [[ "$complete" == "True" ]]; then
      return 0
    fi
    if [[ "$failed" == "True" ]]; then
      kubectl -n "$namespace" logs "job/${name}" || true
      echo "job ${name} failed" >&2
      return 1
    fi
    if ((SECONDS - start > timeout_seconds)); then
      kubectl -n "$namespace" logs "job/${name}" || true
      echo "job ${name} timed out" >&2
      return 1
    fi
    sleep 5
  done
}

apply_job() {
  local step="$1"
  local name="$2"
  local timeout_seconds="$3"
  local manifest
  manifest="$(mktemp)"
  pnpm exec tsx scripts/cd/render-job.ts \
    --step "$step" \
    --name "$name" \
    --namespace "$namespace" \
    --repository "$worker_repository" \
    --digest "$worker_digest" >"$manifest"
  kubectl -n "$namespace" delete job "$name" --ignore-not-found --wait=true
  kubectl apply -f "$manifest"
  rm -f "$manifest"
  wait_for_job "$name" "$timeout_seconds"
}

# phase:release-gate
apply_job release-gate "blakpath-release-gate-${run_id}-${run_attempt}" 240
# phase:migrate
apply_job migrate "blakpath-migrate-${run_id}-${run_attempt}" 660

web_image="$(pnpm exec tsx scripts/cd/image-ref.ts --repository "$web_repository" --digest "$web_digest")"
worker_image="$(pnpm exec tsx scripts/cd/image-ref.ts --repository "$worker_repository" --digest "$worker_digest")"

# phase:rollout
mutated=1
kubectl -n "$namespace" set image deploy/blakpath-app "web=${web_image}"
kubectl -n "$namespace" set image deploy/blakpath-worker "worker=${worker_image}"
kubectl -n "$namespace" rollout status deploy/blakpath-app --timeout=300s
kubectl -n "$namespace" rollout status deploy/blakpath-worker --timeout=300s

# phase:smoke
pnpm exec tsx scripts/cd/smoke.ts --base-url "$app_url"

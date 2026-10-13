#!/usr/bin/env bash
# phase:rollback
# Restores the workload images recorded before this deploy. Does not down-migrate.
set -euo pipefail

cd "$(dirname "$0")/../.."

namespace="${NAMESPACE:?}"
rollback_file="${ROLLBACK_FILE:?}"

web_image="$(awk -F= '$1=="web" { print substr($0, index($0, "=") + 1) }' "$rollback_file")"
worker_image="$(awk -F= '$1=="worker" { print substr($0, index($0, "=") + 1) }' "$rollback_file")"
pnpm exec tsx scripts/cd/assert-rollback.ts "$web_image" "$worker_image"

kubectl -n "$namespace" set image deploy/blakpath-app "web=${web_image}"
kubectl -n "$namespace" set image deploy/blakpath-worker "worker=${worker_image}"
kubectl -n "$namespace" rollout status deploy/blakpath-app --timeout=300s
kubectl -n "$namespace" rollout status deploy/blakpath-worker --timeout=300s
echo "workloads restored"

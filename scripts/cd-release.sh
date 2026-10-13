#!/usr/bin/env bash
# Apply the release migrate Job, wait for it, and only then roll web + worker.
# A failed or timed-out migration leaves the Deployments unchanged.
#
# Required:
#   IMAGE         app image pinned by digest (…/blakpath/app@sha256:…)
#   WORKER_IMAGE  worker image pinned by digest
#   RELEASE_ID    git sha (7–40 hex chars), used as the Job name suffix
# Optional:
#   NAMESPACE     default blakpath
#   DRY_RUN=1     render and kustomize only; do not call kubectl apply
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

: "${IMAGE:?IMAGE is required (app image @sha256 digest)}"
: "${WORKER_IMAGE:?WORKER_IMAGE is required (worker image @sha256 digest)}"
: "${RELEASE_ID:?RELEASE_ID is required (git sha)}"
namespace="${NAMESPACE:-blakpath}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cp -R infra/k8s/. "$workdir/"
pnpm exec tsx scripts/render-release.ts "$workdir"

job_file="$workdir/migrate-job.yaml"
job_name="blakpath-migrate-${RELEASE_ID}"

if ! grep -Fq "image: ${IMAGE}" "$job_file"; then
  echo "migrate job image is not the app release digest; deployments were not changed" >&2
  exit 1
fi

rendered="$(kubectl kustomize "$workdir")"
if ! grep -Fq "image: ${IMAGE}" <<<"$rendered"; then
  echo "refusing rollout: rendered app Deployment is not ${IMAGE}" >&2
  exit 1
fi
if ! grep -Fq "image: ${WORKER_IMAGE}" <<<"$rendered"; then
  echo "refusing rollout: rendered worker Deployment is not ${WORKER_IMAGE}" >&2
  exit 1
fi

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "dry run ok: migrate job ${job_name} and deployments pin the release digests"
  exit 0
fi

if ! kubectl config current-context >/dev/null 2>&1; then
  echo "No Kubernetes context. Refusing to deploy." >&2
  exit 1
fi

kubectl apply -n "$namespace" -f "$job_file"

deadline=$((SECONDS + 900))
complete=""
while (( SECONDS < deadline )); do
  complete="$(kubectl get job "$job_name" -n "$namespace" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)"
  failed="$(kubectl get job "$job_name" -n "$namespace" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)"
  if [[ "$complete" == "True" ]]; then
    break
  fi
  if [[ "$failed" == "True" ]]; then
    echo "migrate job failed; application deployments were not changed" >&2
    kubectl logs -n "$namespace" "job/${job_name}" --tail=200 >&2 || true
    exit 1
  fi
  sleep 5
done

if [[ "$complete" != "True" ]]; then
  echo "migrate job timed out; application deployments were not changed" >&2
  kubectl logs -n "$namespace" "job/${job_name}" --tail=200 >&2 || true
  exit 1
fi

echo "migrations complete; rolling web and worker"
kubectl apply -n "$namespace" -f - <<<"$rendered"

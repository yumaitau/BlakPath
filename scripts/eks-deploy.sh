#!/usr/bin/env bash
# The single production rollout path:
#   1. release gate: the release-check Job runs `node release-check.cjs` in the
#      candidate web and worker images with the production ConfigMap, runtime
#      Secret and migrator URL;
#   2. the release-pinned migrate Job (blakpath-migrate-<RELEASE_ID>) runs
#      `node /app/migrate.cjs` from the app image digest;
#   3. web and worker roll out at the same digests.
# A failed or timed-out step stops the rollout; Deployments are not changed.
#
# Required:
#   IMAGE         app image pinned by digest (…/blakpath/app@sha256:…)
#   WORKER_IMAGE  worker image pinned by digest (…/blakpath/worker@sha256:…)
#   RELEASE_ID    git sha (7–40 hex chars), used as the migrate Job name suffix
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

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R infra/k8s/. "$work/"
# Pins both kustomizations (workloads and release-check) to the digests and
# renders migrate-job.yaml. Refuses tags.
pnpm exec tsx scripts/render-release.ts "$work"

job_file="$work/migrate-job.yaml"
migrate_job="blakpath-migrate-${RELEASE_ID}"
gate_job="blakpath-release-check"

if ! grep -Fq "image: ${IMAGE}" "$job_file"; then
  echo "migrate job image is not the app release digest; rollout blocked" >&2
  exit 1
fi

gate="$(kubectl kustomize "$work/release-check")"
rendered="$(kubectl kustomize "$work")"
for manifest in gate rendered; do
  for image in "$IMAGE" "$WORKER_IMAGE"; do
    if ! grep -Fq "image: ${image}" <<<"${!manifest}"; then
      echo "refusing rollout: ${manifest} manifests do not pin ${image}" >&2
      exit 1
    fi
  done
done

if [[ "${DRY_RUN:-}" == "1" ]]; then
  echo "dry run ok: ${gate_job}, ${migrate_job} and deployments pin the release digests"
  exit 0
fi

if ! kubectl config current-context >/dev/null 2>&1; then
  echo "No Kubernetes context. Refusing to deploy." >&2
  exit 1
fi

# Wait for a Job to complete. Prints logs and exits non-zero on failure or timeout.
wait_for_job() {
  local name="$1" timeout="$2" label="$3"
  local deadline=$((SECONDS + timeout)) result=''
  while (( SECONDS < deadline )); do
    result="$(kubectl get job -n "$namespace" "$name" \
      -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}' 2>/dev/null || true)"
    if grep -q '^Complete=True' <<<"$result"; then
      return 0
    fi
    if grep -q '^Failed=True' <<<"$result"; then
      echo "${label} failed; rollout blocked, deployments were not changed" >&2
      kubectl logs -n "$namespace" "job/${name}" --all-containers --tail=200 >&2 || true
      exit 1
    fi
    sleep 3
  done
  echo "${label} did not finish; rollout blocked, deployments were not changed" >&2
  kubectl get pods -n "$namespace" -l "job-name=${name}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.phase}{"\n"}{end}' >&2 || true
  kubectl logs -n "$namespace" "job/${name}" --all-containers --tail=200 >&2 || true
  exit 1
}

echo "Applying namespace, config, and secret sync before the release gate"
kubectl apply -f "$work/namespace.yaml"
kubectl apply -f "$work/serviceaccounts.yaml"
kubectl apply -f "$work/configmap.yaml"
kubectl apply -f "$work/secretstore.yaml"
kubectl apply -f "$work/externalsecret.yaml"
kubectl apply -f "$work/migrator-externalsecret.yaml"

echo "Running ${gate_job} for ${RELEASE_ID}"
kubectl delete job -n "$namespace" "$gate_job" --ignore-not-found
kubectl apply -n "$namespace" -f - <<<"$gate"
wait_for_job "$gate_job" 180 'release:check'

echo "Release gate passed. Running ${migrate_job}"
kubectl apply -n "$namespace" -f "$job_file"
wait_for_job "$migrate_job" 900 'migrate job'

echo "Migrations complete. Rolling web and worker"
kubectl apply -n "$namespace" -f - <<<"$rendered"
kubectl -n "$namespace" rollout status deployment/blakpath-app --timeout=300s
kubectl -n "$namespace" rollout status deployment/blakpath-worker --timeout=300s

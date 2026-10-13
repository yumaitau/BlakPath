#!/usr/bin/env bash
# Roll out only after the release-check Job exits 0.
# The Job runs node release-check.cjs in the candidate web and worker images
# with the production ConfigMap and Secret. A failed gate does not apply workloads.
set -euo pipefail

tag="${1:-}"
if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  echo "usage: scripts/eks-deploy.sh <immutable-image-tag>" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -a "$root/infra/k8s/." "$work/k8s"

sed -i.bak -E "s/^([[:space:]]*newTag:).*/\\1 ${tag}/" \
  "$work/k8s/kustomization.yaml" \
  "$work/k8s/release-check/kustomization.yaml"
rm -f "$work/k8s/kustomization.yaml.bak" "$work/k8s/release-check/kustomization.yaml.bak"

echo "Applying namespace, config, and secret sync before the release gate"
kubectl apply -f "$work/k8s/namespace.yaml"
kubectl apply -f "$work/k8s/serviceaccounts.yaml"
kubectl apply -f "$work/k8s/configmap.yaml"
kubectl apply -f "$work/k8s/externalsecret.yaml"

echo "Running release-check Job for ${tag}"
kubectl delete job -n blakpath blakpath-release-check --ignore-not-found
kubectl apply -k "$work/k8s/release-check"

deadline=$((SECONDS + 180))
result=''
while (( SECONDS < deadline )); do
  result="$(kubectl get job -n blakpath blakpath-release-check \
    -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}' 2>/dev/null || true)"
  if grep -q '^Complete=True' <<<"$result"; then
    break
  fi
  if grep -q '^Failed=True' <<<"$result"; then
    echo "release:check failed; rollout blocked" >&2
    kubectl logs -n blakpath job/blakpath-release-check --all-containers --tail=200 >&2 || true
    exit 1
  fi
  sleep 2
done

if ! grep -q '^Complete=True' <<<"$result"; then
  echo "release:check did not finish; rollout blocked" >&2
  kubectl get pods -n blakpath -l job-name=blakpath-release-check \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.phase}{"\n"}{end}' >&2 || true
  kubectl logs -n blakpath job/blakpath-release-check --all-containers --tail=200 >&2 || true
  exit 1
fi

echo "Release gate passed. Applying workloads."
kubectl apply -k "$work/k8s"
kubectl -n blakpath rollout status deployment/blakpath-app --timeout=300s
kubectl -n blakpath rollout status deployment/blakpath-worker --timeout=300s

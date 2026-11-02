#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/.."
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
helm lint helm/multiserver
helm template multiserver helm/multiserver --namespace multiserver > "$tmp"
diff -u k8s/multiserver.yaml "$tmp"
helm template custom helm/multiserver --namespace custom \
    --set autoscaling.enabled=false --set replicaCount=2 \
    --set image.tag=test --set authSecret=existing-token \
    --set ingress.host=example.test --set ingress.tlsSecret=existing-tls > "$tmp"
echo 'Helm lint, checked-in manifest parity, and custom values render passed.'

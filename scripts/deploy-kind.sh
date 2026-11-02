#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
for tool in docker kind kubectl helm curl; do
    command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done

cluster=multiserver
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export KUBECONFIG="$tmp/kubeconfig"
if ! kind get clusters | grep -qx "$cluster"; then
    kind create cluster --name "$cluster" --config k8s/kind.yaml \
        --image kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5 \
        --wait 120s
else
    kind export kubeconfig --name "$cluster" --kubeconfig "$KUBECONFIG"
fi

docker build -t multiserver-app:local ./app
kind load docker-image multiserver-app:local --name "$cluster"

# kind uses self-signed kubelet certificates; this flag stays in the local helper.
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.9.1/components.yaml
if ! kubectl get deployment metrics-server -n kube-system \
    -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q -- '--kubelet-insecure-tls'; then
    kubectl patch deployment metrics-server -n kube-system --type=json \
        -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
fi
kubectl rollout status deployment/metrics-server -n kube-system --timeout=180s

helm upgrade --install traefik traefik \
    --repo https://traefik.github.io/charts --version 42.2.0 \
    --namespace multiserver-ingress --create-namespace \
    --set service.type=NodePort --set ports.web.nodePort=30080 \
    --set ports.websecure.expose.default=false \
    --set providers.kubernetesGateway.enabled=false \
    --set resources.requests.cpu=50m --set resources.requests.memory=64Mi \
    --set resources.limits.cpu=250m --set resources.limits.memory=128Mi \
    --wait --timeout 180s

helm lint helm/multiserver
helm upgrade --install multiserver helm/multiserver --namespace multiserver \
    --create-namespace --wait --timeout 180s
# The local tag can be rebuilt without changing a Deployment's image string.
kubectl rollout restart deployment/multiserver-app -n multiserver
kubectl rollout status deployment/multiserver-app -n multiserver --timeout=180s
kubectl wait --for=condition=AbleToScale hpa/multiserver-app -n multiserver --timeout=120s
kubectl wait --for=condition=ScalingActive hpa/multiserver-app -n multiserver --timeout=120s
BASE_URL=http://localhost:8081 ./scripts/test.sh
kubectl get deployments,hpa,ingress,pvc -n multiserver
printf '\nReady at http://localhost:8081 (local HTTP).\n'
printf 'Inspect: kind export kubeconfig --name multiserver\n'
printf 'Remove this test cluster and its data: kind delete cluster --name multiserver\n'

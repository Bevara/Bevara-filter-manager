#!/usr/bin/env bash
# Builds the registry image and pushes it to the cluster's local registry.
set -euo pipefail
VERSION="${1:-1.0.0}"
IMAGE="192.168.1.120:32000/bevara-registry:${VERSION}"
cd "$(dirname "$0")/../../packages/registry"
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
echo "pushed $IMAGE — update deploy/k8s/registry.yaml if the tag changed"

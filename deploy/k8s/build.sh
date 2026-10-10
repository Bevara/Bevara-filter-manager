#!/usr/bin/env bash
# Builds the registry image and pushes it to the cluster's local registry.
# The tag is the version in packages/registry/package.json, the one
# deploy/k8s/registry.yaml references (a test keeps the two equal).
set -euo pipefail
cd "$(dirname "$0")/../../packages/registry"
VERSION="${1:-$(node -p "require('./package.json').version")}"
IMAGE="localhost:32000/bevara-registry:${VERSION}"
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
echo "pushed $IMAGE"

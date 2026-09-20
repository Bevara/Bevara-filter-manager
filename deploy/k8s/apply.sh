#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
K="${KUBECTL:-microk8s kubectl}"
if [ ! -f secret.yaml ]; then echo "create secret.yaml from secret.example.yaml first"; exit 1; fi
$K apply -f secret.yaml
$K apply -f registry.yaml
$K apply -f ingress.yaml
$K rollout status deployment/bevara-registry

#!/usr/bin/env bash
set -euo pipefail
K="${KUBECTL:-microk8s kubectl}"
$K delete ingress bevara-registry-ingress --ignore-not-found
$K delete service bevara-registry --ignore-not-found
$K delete deployment bevara-registry --ignore-not-found
# Keeps the PVC (published filters). Remove it explicitly if you really want to:
#   $K delete pvc bevara-registry-data

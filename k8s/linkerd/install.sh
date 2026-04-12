#!/usr/bin/env bash
# install.sh — Install or upgrade the Linkerd control plane.
#
# PRD §7 requires mutually authenticated and encrypted inter-service traffic.
# This script installs Linkerd 2.14 (stable) with mTLS enabled by default
# for all namespaces annotated with `linkerd.io/inject: enabled`.
#
# The script is idempotent:
#   - Checks whether linkerd CLI is available and installs it if not.
#   - Runs `linkerd check --pre` to verify cluster pre-conditions.
#   - Applies the CRD manifest first, then the control-plane manifest.
#   - Runs `linkerd check` after installation to verify the control plane.
#
# Usage:
#   ./k8s/linkerd/install.sh [--version 2.14.10] [--context my-k8s-context]
#
# Environment variables:
#   LINKERD_VERSION    Override the default Linkerd version (default: 2.14.10)
#   KUBECONTEXT        kubectl context to use (default: current context)
#
# Canonical references:
#   https://linkerd.io/2.14/tasks/install/
#   https://linkerd.io/2.14/reference/helm-chart/
#   https://linkerd.io/2.14/tasks/upgrade/

set -euo pipefail

LINKERD_VERSION="${LINKERD_VERSION:-2.14.10}"
KUBECONTEXT="${KUBECONTEXT:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[linkerd-install] $*"; }
err() { echo "[linkerd-install] ERROR: $*" >&2; exit 1; }

# ── 1. Ensure linkerd CLI is available ─────────────────────────────────────

if ! command -v linkerd &>/dev/null; then
  log "linkerd CLI not found — installing v${LINKERD_VERSION}..."
  curl -fsL "https://run.linkerd.io/install" | LINKERD2_VERSION="${LINKERD_VERSION}" sh
  export PATH="${HOME}/.linkerd2/bin:${PATH}"
fi

INSTALLED_VERSION=$(linkerd version --client --short 2>/dev/null || echo "unknown")
log "Using linkerd CLI: ${INSTALLED_VERSION}"

# ── 2. Configure kubectl context ───────────────────────────────────────────

KUBECTL_ARGS=()
if [[ -n "${KUBECONTEXT}" ]]; then
  KUBECTL_ARGS+=(--context "${KUBECONTEXT}")
fi

# ── 3. Pre-flight checks ────────────────────────────────────────────────────

log "Running linkerd pre-installation checks..."
linkerd check --pre "${KUBECTL_ARGS[@]}" \
  || err "Pre-flight checks failed. Resolve the issues above before installing."

# ── 4. Apply namespaces (must exist before control-plane install) ───────────

log "Applying namespace manifests..."
kubectl "${KUBECTL_ARGS[@]}" apply -f "${SCRIPT_DIR}/namespaces.yaml"

# ── 5. Install Linkerd CRDs ─────────────────────────────────────────────────

log "Installing Linkerd CRDs..."
linkerd install --crds "${KUBECTL_ARGS[@]}" | kubectl "${KUBECTL_ARGS[@]}" apply -f -

# ── 6. Install Linkerd control plane ───────────────────────────────────────

log "Installing Linkerd control plane (version ${LINKERD_VERSION})..."
linkerd install \
  --set proxyInit.ignoreOutboundPorts="4567,4568" \
  "${KUBECTL_ARGS[@]}" \
  | kubectl "${KUBECTL_ARGS[@]}" apply -f -

# ── 7. Wait for control plane readiness ────────────────────────────────────

log "Waiting for Linkerd control plane to be ready..."
kubectl "${KUBECTL_ARGS[@]}" -n linkerd rollout status deployment/linkerd-destination --timeout=5m
kubectl "${KUBECTL_ARGS[@]}" -n linkerd rollout status deployment/linkerd-identity --timeout=5m
kubectl "${KUBECTL_ARGS[@]}" -n linkerd rollout status deployment/linkerd-proxy-injector --timeout=5m

# ── 8. Post-install health check ───────────────────────────────────────────

log "Running linkerd post-installation checks..."
linkerd check "${KUBECTL_ARGS[@]}" \
  || err "Post-installation checks failed."

# ── 9. Apply authorization policies ────────────────────────────────────────

log "Applying authorization policies..."
kubectl "${KUBECTL_ARGS[@]}" apply -f "${SCRIPT_DIR}/authorization-policies.yaml"

log "Linkerd ${LINKERD_VERSION} installation complete."
log "All namespaces in namespaces.yaml have sidecar injection enabled."
log "Default-deny authorization policies are in effect."

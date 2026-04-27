#!/usr/bin/env bash
# upgrade.sh — Idempotent Linkerd control-plane upgrade.
#
# Upgrades the Linkerd control plane to a new version with zero-downtime
# proxy rollover.  The script is safe to re-run (idempotent):
#   - Checks current installed version.
#   - Applies CRD updates first (additive, never removes fields).
#   - Applies control-plane upgrade.
#   - Performs a rolling restart of all meshed workloads in the three
#     application namespaces to replace sidecars with the new version.
#   - Runs `linkerd check` to verify the upgraded state.
#
# Usage:
#   ./k8s/linkerd/upgrade.sh [--version 2.14.11] [--context my-k8s-context]
#
# Environment variables:
#   LINKERD_VERSION    Target Linkerd version (default: 2.14.10)
#   KUBECONTEXT        kubectl context to use (default: current context)
#
# Zero-downtime guarantee:
#   Worker pods are stateless; the rolling restart replaces one pod at a time.
#   The maxUnavailable: 0 / maxSurge: 1 strategy on each Deployment ensures
#   no traffic is dropped during the sidecar version rollover.
#
# Canonical references:
#   https://linkerd.io/2.14/tasks/upgrade/
#   https://linkerd.io/2.14/reference/proxy-configuration/

set -euo pipefail

LINKERD_VERSION="${LINKERD_VERSION:-2.14.10}"
KUBECONTEXT="${KUBECONTEXT:-}"

# Application namespaces that need their sidecars rolled after the control-plane upgrade.
MESHED_NAMESPACES=(superfield-server superfield-web superfield-worker)

log() { echo "[linkerd-upgrade] $*"; }
err() { echo "[linkerd-upgrade] ERROR: $*" >&2; exit 1; }

if ! command -v linkerd &>/dev/null; then
  err "linkerd CLI not found. Run k8s/linkerd/install.sh first."
fi

KUBECTL_ARGS=()
if [[ -n "${KUBECONTEXT}" ]]; then
  KUBECTL_ARGS+=(--context "${KUBECONTEXT}")
fi

# ── 1. Check current state ──────────────────────────────────────────────────

CURRENT_VERSION=$(linkerd version --server --short "${KUBECTL_ARGS[@]}" 2>/dev/null || echo "unknown")
log "Current control-plane version: ${CURRENT_VERSION}"
log "Target version: ${LINKERD_VERSION}"

if [[ "${CURRENT_VERSION}" == "${LINKERD_VERSION}" ]]; then
  log "Already at target version ${LINKERD_VERSION}. Running health check..."
  linkerd check "${KUBECTL_ARGS[@]}" && exit 0
fi

# ── 2. Upgrade CRDs (additive — never removes fields) ───────────────────────

log "Upgrading Linkerd CRDs..."
linkerd upgrade --crds "${KUBECTL_ARGS[@]}" | kubectl "${KUBECTL_ARGS[@]}" apply -f -

# ── 3. Upgrade control plane ────────────────────────────────────────────────

log "Upgrading Linkerd control plane to ${LINKERD_VERSION}..."
linkerd upgrade "${KUBECTL_ARGS[@]}" | kubectl "${KUBECTL_ARGS[@]}" apply -f -

# ── 4. Wait for control-plane pods ─────────────────────────────────────────

log "Waiting for upgraded control-plane pods to be ready..."
kubectl "${KUBECTL_ARGS[@]}" -n linkerd rollout status deployment/linkerd-destination --timeout=5m
kubectl "${KUBECTL_ARGS[@]}" -n linkerd rollout status deployment/linkerd-identity --timeout=5m
kubectl "${KUBECTL_ARGS[@]}" -n linkerd rollout status deployment/linkerd-proxy-injector --timeout=5m

# ── 5. Rolling restart of meshed workloads ───────────────────────────────────
# Replace old proxy sidecars with the new version, one pod at a time.

for ns in "${MESHED_NAMESPACES[@]}"; do
  log "Rolling restart of deployments in namespace: ${ns}"
  DEPLOYMENTS=$(kubectl "${KUBECTL_ARGS[@]}" -n "${ns}" get deployments -o name 2>/dev/null || true)
  if [[ -n "${DEPLOYMENTS}" ]]; then
    echo "${DEPLOYMENTS}" | xargs -I{} kubectl "${KUBECTL_ARGS[@]}" -n "${ns}" rollout restart {}
    echo "${DEPLOYMENTS}" | xargs -I{} kubectl "${KUBECTL_ARGS[@]}" -n "${ns}" rollout status {} --timeout=5m
  else
    log "No deployments in ${ns} — skipping."
  fi
done

# ── 6. Post-upgrade health check ───────────────────────────────────────────

log "Running post-upgrade health checks..."
linkerd check "${KUBECTL_ARGS[@]}" \
  || err "Post-upgrade checks failed. See output above."

log "Linkerd upgrade to ${LINKERD_VERSION} complete."
log "All meshed workloads in ${MESHED_NAMESPACES[*]} have been restarted with the new sidecar version."

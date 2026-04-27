#!/usr/bin/env bash
# whoami.sh — report current Superfield deployment state without making changes
#
# Usage:
#   bash scripts/whoami.sh [<env>]
#
# <env> is the deployment environment label (default: "demo").
# The Kubernetes namespace checked is "superfield-<env>".
#
# Output example:
#   Namespace:  superfield-demo
#   Image tag:  ghcr.io/dot-matrix-labs/calypso-starter-ts:v1.2.3
#   Domain:     (NodePort — no ingress domain)
#   DB mode:    local
#   Secrets:    superfield-api-secrets ✓ (all keys present)
#
# Secret values are never printed — only presence is checked.

set -euo pipefail

ENV_LABEL="${1:-demo}"
NAMESPACE="superfield-${ENV_LABEL}"
REPO="ghcr.io/dot-matrix-labs/calypso-starter-ts"

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

echo "Namespace:  ${NAMESPACE}"

# ── Image tag ─────────────────────────────────────────────────────────────────

IMAGE=""
if kubectl get deployment superfield-app --namespace="${NAMESPACE}" &>/dev/null 2>&1; then
  IMAGE=$(kubectl get deployment superfield-app \
    --namespace="${NAMESPACE}" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
fi

if [[ -n "${IMAGE}" ]]; then
  echo "Image tag:  ${IMAGE}"
else
  echo "Image tag:  (deployment not found)"
fi

# ── Domain / ingress ──────────────────────────────────────────────────────────

DOMAIN=""
if kubectl get ingress --namespace="${NAMESPACE}" &>/dev/null 2>&1; then
  DOMAIN=$(kubectl get ingress --namespace="${NAMESPACE}" \
    -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || echo "")
fi

if [[ -n "${DOMAIN}" ]]; then
  echo "Domain:     ${DOMAIN}"
else
  echo "Domain:     (NodePort — no ingress domain)"
fi

# ── DB mode ───────────────────────────────────────────────────────────────────

DB_MODE="unknown"
if kubectl get statefulset postgres --namespace="${NAMESPACE}" &>/dev/null 2>&1; then
  DB_MODE="local"
elif kubectl get secret superfield-api-secrets --namespace="${NAMESPACE}" &>/dev/null 2>&1; then
  # Check if DATABASE_URL points to an external host (not 'postgres' service)
  DB_URL=$(kubectl get secret superfield-api-secrets \
    --namespace="${NAMESPACE}" \
    -o jsonpath='{.data.DATABASE_URL}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  if echo "${DB_URL}" | grep -q "@postgres:"; then
    DB_MODE="local"
  elif [[ -n "${DB_URL}" ]]; then
    DB_MODE="remote"
  fi
fi

echo "DB mode:    ${DB_MODE}"

# ── Secrets presence check ────────────────────────────────────────────────────

check_secret() {
  local secret_name="$1"
  shift
  local required_keys=("$@")

  if ! kubectl get secret "${secret_name}" --namespace="${NAMESPACE}" &>/dev/null 2>&1; then
    echo "Secrets:    ${secret_name} ✗ (not found)"
    return
  fi

  local missing_keys=()
  for key in "${required_keys[@]}"; do
    val=$(kubectl get secret "${secret_name}" \
      --namespace="${NAMESPACE}" \
      -o jsonpath="{.data.${key}}" 2>/dev/null || echo "")
    if [[ -z "${val}" ]]; then
      missing_keys+=("${key}")
    fi
  done

  if [[ ${#missing_keys[@]} -eq 0 ]]; then
    echo "Secrets:    ${secret_name} ✓ (all keys present)"
  else
    echo "Secrets:    ${secret_name} ✗ (missing: ${missing_keys[*]})"
  fi
}

check_secret "superfield-api-secrets" \
  "DATABASE_URL" "AUDIT_DATABASE_URL" "ANALYTICS_DATABASE_URL" "JWT_SECRET" "ENCRYPTION_MASTER_KEY"
check_secret "superfield-db-secrets" \
  "APP_RW_PASSWORD" "AUDIT_W_PASSWORD" "ANALYTICS_W_PASSWORD"

# ── Pod status summary ────────────────────────────────────────────────────────

echo ""
echo "Pods (${NAMESPACE}):"
kubectl get pods --namespace="${NAMESPACE}" \
  --no-headers \
  -o custom-columns='  NAME:.metadata.name,STATUS:.status.phase,READY:.status.conditions[?(@.type=="Ready")].status' \
  2>/dev/null || echo "  (none)"

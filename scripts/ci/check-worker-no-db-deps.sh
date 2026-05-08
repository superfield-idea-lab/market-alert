#!/usr/bin/env bash
# check-worker-no-db-deps.sh — CI guard: worker must not list postgres/pg deps.
#
# Phase 1: Linkerd mTLS and machine tokens for workers.
#
# Workers access data exclusively through the API gateway using WORKER_TOKEN.
# Direct postgres client dependencies in apps/worker/package.json would enable
# workers to bypass the mTLS/token model if credentials were ever injected.
#
# This script fails the CI job with a non-zero exit code if any of the
# following package names appear in apps/worker/package.json (dependencies,
# devDependencies, or peerDependencies):
#
#   postgres    pg    pg-native    pg-promise    pgpool    node-postgres
#   @types/pg   @vercel/postgres
#
# Usage:
#   scripts/ci/check-worker-no-db-deps.sh
#
# Exit codes:
#   0 — no forbidden postgres dependencies found
#   1 — one or more forbidden dependencies detected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKER_PKG="${REPO_ROOT}/apps/worker/package.json"

# Forbidden postgres-client package names (exact match against dependency keys).
FORBIDDEN_PATTERNS=(
  '"postgres"'
  '"pg"'
  '"pg-native"'
  '"pg-promise"'
  '"pgpool"'
  '"node-postgres"'
  '"@types/pg"'
  '"@vercel/postgres"'
)

echo "ci: checking apps/worker/package.json for forbidden postgres/pg dependencies..."

if [[ ! -f "${WORKER_PKG}" ]]; then
  echo "ERROR: ${WORKER_PKG} not found" >&2
  exit 1
fi

found=()
for pattern in "${FORBIDDEN_PATTERNS[@]}"; do
  if grep -q "${pattern}" "${WORKER_PKG}"; then
    found+=("${pattern}")
  fi
done

if [[ "${#found[@]}" -gt 0 ]]; then
  echo "" >&2
  echo "FAIL: apps/worker/package.json contains forbidden postgres/pg dependencies:" >&2
  for dep in "${found[@]}"; do
    echo "  ${dep}" >&2
  done
  echo "" >&2
  echo "Workers must not have direct database client dependencies." >&2
  echo "Data access must go through the API gateway via WORKER_TOKEN." >&2
  echo "See: docs/plan.md, k8s/linkerd/authorization-policies.yaml" >&2
  exit 1
fi

echo "ci: OK — no forbidden postgres/pg dependencies found in apps/worker/package.json"
exit 0

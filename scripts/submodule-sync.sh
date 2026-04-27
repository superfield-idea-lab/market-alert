#!/usr/bin/env bash
# scripts/submodule-sync.sh — Initialise and update the blueprint submodule.
#
# Usage:
#   bash scripts/submodule-sync.sh
#
# Exits 0 when the blueprint submodule is up to date.
# Exits 1 with a diagnostic message on error.
#
# The script is idempotent: running it a second time on an already-synced tree
# produces no output beyond the success message and exits 0.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

SUBMODULE_PATH="calypso-blueprint"

echo "Syncing submodule ${SUBMODULE_PATH} in ${REPO_ROOT} ..."

if ! git -C "${REPO_ROOT}" submodule update --init --recursive -- "${SUBMODULE_PATH}" 2>&1; then
  echo "ERROR: submodule sync failed for '${SUBMODULE_PATH}'" >&2
  exit 1
fi

echo "Submodule ${SUBMODULE_PATH} is up to date."

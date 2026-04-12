#!/usr/bin/env bash
# restore-postgres.sh — Restore a Calypso Postgres backup into a target database.
#
# Decrypts a backup artifact (produced by backup-postgres.sh / backupDatabase())
# using the KMS-recovered data key and pipes the cleartext dump through
# pg_restore into the target database.
#
# Usage:
#   ./scripts/restore-postgres.sh --enc-file PATH --meta-file PATH --target-url URL
#
# Required arguments:
#   --enc-file   PATH  — Path to the .dump.enc artifact file
#   --meta-file  PATH  — Path to the companion .meta.json sidecar file
#   --target-url URL   — Postgres connection URL for the restore destination
#
# Environment variables:
#   ENCRYPTION_MASTER_KEY — Required when the backup is encrypted (set in production)
#
# The restore operation is idempotent: pg_restore is invoked with --clean
# --if-exists so that re-running against the same target drops and recreates
# objects without error.
#
# Blueprint: DATA blueprint, PRD §7 — scripted restore procedure.
# Issue #91 — encrypted Postgres backup and tested restore runbook.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

ENC_FILE=""
META_FILE=""
TARGET_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --enc-file)
      ENC_FILE="$2"
      shift 2
      ;;
    --meta-file)
      META_FILE="$2"
      shift 2
      ;;
    --target-url)
      TARGET_URL="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------

if [[ -z "${ENC_FILE}" || -z "${META_FILE}" || -z "${TARGET_URL}" ]]; then
  echo "Usage: $0 --enc-file PATH --meta-file PATH --target-url URL" >&2
  exit 1
fi

if [[ ! -f "${ENC_FILE}" ]]; then
  echo "Artifact not found: ${ENC_FILE}" >&2
  exit 1
fi

if [[ ! -f "${META_FILE}" ]]; then
  echo "Sidecar not found: ${META_FILE}" >&2
  exit 1
fi

echo "[restore] Starting restore from ${ENC_FILE}"
echo "[restore] Sidecar:    ${META_FILE}"
echo "[restore] Target URL: ${TARGET_URL%@*}@..." # mask password

# ---------------------------------------------------------------------------
# Run restore via the TypeScript restore helper
# ---------------------------------------------------------------------------

ENC_FILE="${ENC_FILE}" \
META_FILE="${META_FILE}" \
TARGET_URL="${TARGET_URL}" \
  bun run - <<'EOF'
import { restoreDatabase } from './packages/db/backup.ts';

const encFile = process.env.ENC_FILE!;
const metaFile = process.env.META_FILE!;
const targetUrl = process.env.TARGET_URL!;

await restoreDatabase(encFile, metaFile, targetUrl);
console.log('[restore] Restore complete.');
EOF

echo "[restore] Done."

#!/usr/bin/env bash
# backup-postgres.sh — Encrypted Postgres backup script for Superfield.
#
# Creates AES-256-GCM encrypted backups of the application and audit databases
# using pg_dump (custom format). Each backup artifact is accompanied by a JSON
# sidecar file containing the KMS-encrypted data key (envelope encryption).
#
# Usage:
#   ./scripts/backup-postgres.sh [--store-dir DIR]
#
# Environment variables (all optional — sensible defaults apply for local dev):
#   DATABASE_URL        — App database connection URL
#   AUDIT_DATABASE_URL  — Audit database connection URL
#   BACKUP_STORE_DIR    — Directory for backup artifacts (default: /var/backups/superfield)
#   ENCRYPTION_MASTER_KEY — Required for encrypted backups (set in production)
#
# When ENCRYPTION_MASTER_KEY is not set the dump is written unencrypted.
# This is safe for local development but MUST NOT be used in production.
#
# Blueprint: DATA blueprint, PRD §7 — backup cadence and encrypt-at-rest.
# Issue #91 — encrypted Postgres backup and tested restore runbook.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------

BACKUP_STORE_DIR="${BACKUP_STORE_DIR:-/var/backups/superfield}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --store-dir)
      BACKUP_STORE_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

DATABASE_URL="${DATABASE_URL:-postgres://app_rw:app_rw_password@localhost:5432/superfield_app}"
AUDIT_DATABASE_URL="${AUDIT_DATABASE_URL:-postgres://audit_w:audit_w_password@localhost:5432/superfield_audit}"

mkdir -p "${BACKUP_STORE_DIR}"

TIMESTAMP="$(date -u '+%Y-%m-%dT%H-%M-%SZ')"

echo "[backup] Starting Superfield Postgres backup — ${TIMESTAMP}"
echo "[backup] Store dir: ${BACKUP_STORE_DIR}"

# ---------------------------------------------------------------------------
# Run backup via the TypeScript backup helper
# ---------------------------------------------------------------------------

BACKUP_STORE_DIR="${BACKUP_STORE_DIR}" \
DATABASE_URL="${DATABASE_URL}" \
AUDIT_DATABASE_URL="${AUDIT_DATABASE_URL}" \
  bun run - <<'EOF'
import { runScheduledBackup, loadBackupConfig } from './packages/db/backup.ts';

const config = loadBackupConfig(process.env);
const results = await runScheduledBackup(config);
for (const r of results) {
  console.log(`[backup] artifact: ${r.encFilePath}`);
  console.log(`[backup] sidecar:  ${r.metaFilePath}`);
}
console.log('[backup] All backups complete.');
EOF

echo "[backup] Done."

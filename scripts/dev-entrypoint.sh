#!/usr/bin/env sh
# dev-entrypoint.sh — startup sequence for the development container.
#
# Steps:
#   1. Wait for PostgreSQL TCP to become reachable.
#   2. Run bun run migrate (idempotent).
#   3. Run seed script once (sentinel file guard).
#   4. exec bun --hot run apps/server/src/index.ts

set -e

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
SENTINEL_FILE="/tmp/.seed-done"

# ---------------------------------------------------------------------------
# 1. Wait for PostgreSQL TCP
# ---------------------------------------------------------------------------
echo "[entrypoint] Waiting for PostgreSQL at ${PGHOST}:${PGPORT}..."
timeout=60
elapsed=0
until bun -e "
  const net = require('net');
  const client = net.createConnection({ host: '${PGHOST}', port: ${PGPORT} });
  client.on('connect', () => { client.destroy(); process.exit(0); });
  client.on('error', () => process.exit(1));
" 2>/dev/null; do
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "[entrypoint] ERROR: Timed out waiting for PostgreSQL after ${timeout}s" >&2
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] PostgreSQL is reachable."

# ---------------------------------------------------------------------------
# 2. Run migrations (idempotent)
# ---------------------------------------------------------------------------
echo "[entrypoint] Running migrations..."
bun run packages/db/migrate.ts
echo "[entrypoint] Migrations complete."

# ---------------------------------------------------------------------------
# 3. Run seed script once (sentinel file guard)
# ---------------------------------------------------------------------------
if [ ! -f "$SENTINEL_FILE" ]; then
  if [ -f "packages/db/seed.ts" ]; then
    echo "[entrypoint] Running seed script..."
    bun run packages/db/seed.ts
    touch "$SENTINEL_FILE"
    echo "[entrypoint] Seed complete."
  else
    echo "[entrypoint] No seed script found, skipping."
    touch "$SENTINEL_FILE"
  fi
else
  echo "[entrypoint] Seed already run, skipping."
fi

# ---------------------------------------------------------------------------
# 4. Start the application with hot-reload
# ---------------------------------------------------------------------------
echo "[entrypoint] Starting server with hot-reload..."
exec bun --hot run apps/server/src/index.ts

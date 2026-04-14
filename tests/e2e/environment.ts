import type { Subprocess } from 'bun';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import postgres from 'postgres';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';
const AUDIT_SCHEMA_PATH = join(REPO_ROOT, 'packages/db/audit-schema.sql');
const SERVER_ENTRY_ABS = join(REPO_ROOT, SERVER_ENTRY);
const SERVER_BASE_PORT = Number(process.env.PORT ?? 31415);
const WORKER_ID = Number(process.env.VITEST_WORKER_ID ?? process.env.VITEST_WORKER ?? 0);
const SERVER_PORT = SERVER_BASE_PORT + WORKER_ID;
const SERVER_READY_TIMEOUT_MS = 20_000;
const BUN_BIN =
  process.env.BUN_BIN ?? (existsSync('/usr/local/bin/bun') ? '/usr/local/bin/bun' : 'bun');

export type E2EEnvironment = {
  pg: PgContainer;
  server: Subprocess;
  baseUrl: string;
};

export async function startE2EServer(): Promise<E2EEnvironment> {
  await runBuild();
  const pg = await startPostgres();
  await applyAuditSchema(pg.url);

  // Migrate the audit schema into the same ephemeral pg container so that
  // audit-before-write endpoints (transcript ingestion, wiki writes, etc.)
  // can succeed in the test environment.
  await migrateAuditSchema(pg.url);

  const server = Bun.spawn([BUN_BIN, 'run', SERVER_ENTRY_ABS], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      // Route audit writes to the same test Postgres container so
      // POST /internal/wiki/versions and other audit-guarded endpoints work
      // without an external audit database.
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(SERVER_PORT),
      // Enable the test-session backdoor so integration tests can obtain
      // session cookies without going through the WebAuthn ceremony.
      TEST_MODE: 'true',
      // Disable CSRF in the E2E test environment so API tests can make
      // authenticated POST requests without managing the double-submit token.
      CSRF_DISABLED: 'true',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer();

  return {
    pg,
    server,
    baseUrl: `http://localhost:${SERVER_PORT}`,
  };
}

export async function stopE2EServer(context: E2EEnvironment): Promise<void> {
  context.server.kill();
  await context.pg.stop();
}

/**
 * Apply the audit schema DDL to the test Postgres container.
 *
 * The main migrate() call covers the app schema. The audit_events table lives
 * in a separate schema file (packages/db/audit-schema.sql) and is normally
 * created by init-remote.ts at deploy time. For E2E tests we apply it directly
 * to the same pg container so audit-gated endpoints (e.g. POST
 * /internal/wiki/versions) succeed without a separate audit database.
 */
/**
 * Apply the audit schema DDL to the test Postgres container.
 *
 * The main migrate() call covers the app schema. The audit_events table lives
 * in a separate schema file (packages/db/audit-schema.sql) and is normally
 * created by init-remote.ts at deploy time. For E2E tests we apply it directly
 * to the same pg container so audit-gated endpoints (e.g. POST
 * /internal/wiki/versions) succeed without a separate audit database.
 */
async function applyAuditSchema(pgUrl: string): Promise<void> {
  const sql = postgres(pgUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    const rawSql = readFileSync(AUDIT_SCHEMA_PATH, 'utf-8');
    // Strip single-line SQL comments before splitting so comment-only lines
    // that precede a statement (e.g. "-- Audit database schema\nCREATE TABLE…")
    // are removed without discarding the statement body.
    const stripped = rawSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    const statements = stripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await sql.unsafe(stmt);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function runBuild(): Promise<void> {
  const build = Bun.spawnSync([BUN_BIN, 'run', '--filter', 'web', 'build'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (build.exitCode !== 0) {
    throw new Error('Failed to build the web assets.');
  }
}

async function waitForServer(port = SERVER_PORT): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  const base = `http://localhost:${port}`;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/health/live`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

/**
 * Runs the audit schema SQL against the given database URL.
 *
 * In the E2E test environment the audit DB is co-located with the app DB
 * in the same ephemeral pg-container, which means we need to create the
 * audit_events table before the server starts so emitAuditEvent does not
 * throw. In production the four pools are fully isolated; this is
 * test-only co-location.
 */
async function migrateAuditSchema(databaseUrl: string): Promise<void> {
  const auditSchemaPath = join(REPO_ROOT, 'packages/db/audit-schema.sql');
  const schemaSql = readFileSync(auditSchemaPath, 'utf-8');
  const db = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
  });
  try {
    // Split on semicolons (the audit schema has no dollar-quoted blocks)
    const statements = schemaSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.unsafe(stmt);
    }
  } finally {
    await db.end({ timeout: 5 });
  }
}

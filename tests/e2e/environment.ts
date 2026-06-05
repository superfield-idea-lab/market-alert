import type { Subprocess } from 'bun';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import postgres from 'postgres';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';
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

  // Apply the audit schema DDL (dollar-quoted PL/pgSQL blocks) as a single
  // unsafe() call so semicolons inside $$ bodies are not misread as statement
  // boundaries.
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
      // Enable demo mode so seedDemoFixtures() runs at server startup and
      // /api/demo/session is available for fixture-user login in tests.
      DEMO_MODE: 'true',
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
    // audit-schema.sql contains dollar-quoted PL/pgSQL blocks; pass the whole
    // file as one unsafe call so semicolons inside $$ bodies are not misread
    // as statement boundaries (matches pg-container.ts applyAuditSchema).
    await db.unsafe(schemaSql);
  } finally {
    await db.end({ timeout: 5 });
  }
}

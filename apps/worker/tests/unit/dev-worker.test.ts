/**
 * Unit tests for dev worker container configuration.
 *
 * Verifies the docker-compose worker service configuration and dev
 * credential seed script exports without requiring Docker or a database.
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// docker-compose.yml worker service configuration
// ---------------------------------------------------------------------------

describe('docker-compose worker service', () => {
  const composeText = readFileSync(
    join(import.meta.dirname, '../../../../docker-compose.yml'),
    'utf-8',
  );

  test('docker-compose.yml defines a worker service', () => {
    expect(composeText).toContain('worker:');
  });

  test('worker service uses the dev-worker target from the unified Dockerfile', () => {
    // The unified Dockerfile replaces the legacy Dockerfile.worker.dev with a
    // multi-stage build whose dev-worker target wires up the hot-reload entrypoint.
    expect(composeText).toMatch(/dockerfile:\s*Dockerfile\b/);
    expect(composeText).toMatch(/target:\s*dev-worker\b/);
  });

  test('worker service sets AGENT_DATABASE_URL with agent_email_ingest role', () => {
    expect(composeText).toContain('agent_email_ingest');
    expect(composeText).toContain('AGENT_DATABASE_URL');
  });

  test('worker service sets AGENT_TYPE to email_ingest', () => {
    expect(composeText).toContain("AGENT_TYPE: 'email_ingest'");
  });

  test('worker service sets API_BASE_URL pointing to app service', () => {
    expect(composeText).toContain('API_BASE_URL');
    expect(composeText).toContain('http://app:');
  });

  test('worker service sets ENCRYPTION_MASTER_KEY', () => {
    expect(composeText).toContain('ENCRYPTION_MASTER_KEY');
  });

  test('worker service sets CODEX_PATH to dev stub', () => {
    expect(composeText).toContain('CODEX_PATH');
    expect(composeText).toContain('dev-codex-stub');
  });

  test('worker service depends_on postgres (healthy) and app', () => {
    // The worker section contains both postgres and app in depends_on
    const workerSection = composeText.slice(composeText.indexOf('  worker:'));
    expect(workerSection).toContain('postgres');
    expect(workerSection).toContain('app');
  });

  test('postgres service mounts dev-postgres-init for agent role init', () => {
    expect(composeText).toContain('dev-postgres-init');
    expect(composeText).toContain('docker-entrypoint-initdb.d');
  });

  test('ENCRYPTION_MASTER_KEY is the same in app and worker services', () => {
    const keyMatches = composeText.match(/ENCRYPTION_MASTER_KEY:\s*'([0-9a-fA-F]{64})'/g);
    expect(keyMatches).not.toBeNull();
    // Both app and worker must set the same key
    expect(keyMatches!.length).toBe(2);
    const keys = keyMatches!.map((m) => m.match(/'([0-9a-fA-F]{64})'/)![1]);
    expect(keys[0]).toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------
// Dockerfile — `dev-worker` target
//
// The repository consolidated dev worker container configuration into the
// unified Dockerfile with a `dev-worker` build target (replacing the legacy
// Dockerfile.worker.dev). We isolate the dev-worker stage so assertions stay
// scoped to the relevant section.
// ---------------------------------------------------------------------------

describe('Dockerfile dev-worker target', () => {
  const dockerfileText = readFileSync(join(import.meta.dirname, '../../../../Dockerfile'), 'utf-8');

  // The dev-worker stage runs from "FROM oven/bun:${BUN_VERSION} AS dev-worker"
  // through the next "FROM" stage marker (or end-of-file). Extract that slice
  // so we don't accidentally match content from other stages.
  const devWorkerStart = dockerfileText.indexOf('AS dev-worker');
  const devWorkerSection = (() => {
    if (devWorkerStart < 0) return '';
    const after = dockerfileText.slice(devWorkerStart);
    const nextStage = after.indexOf('\nFROM ', 1);
    return nextStage < 0 ? after : after.slice(0, nextStage);
  })();

  test('Dockerfile defines a dev-worker stage on oven/bun base', () => {
    expect(devWorkerStart).toBeGreaterThanOrEqual(0);
    expect(dockerfileText).toContain('FROM oven/bun:');
  });

  test('dev-worker stage copies dev-worker-entrypoint.sh', () => {
    expect(devWorkerSection).toContain('dev-worker-entrypoint.sh');
  });

  test('dev-worker stage copies dev-codex-stub', () => {
    expect(devWorkerSection).toContain('dev-codex-stub');
  });

  test('dev-worker stage sets CODEX_PATH to dev stub', () => {
    expect(devWorkerSection).toContain('CODEX_PATH=/app/scripts/dev-codex-stub');
  });
});

// ---------------------------------------------------------------------------
// dev-postgres-init SQL script
// ---------------------------------------------------------------------------

describe('dev-postgres-init agent roles SQL', () => {
  const sqlText = readFileSync(
    join(import.meta.dirname, '../../../../scripts/dev-postgres-init/01-agent-roles.sql'),
    'utf-8',
  );

  test('SQL creates agent_worker base role', () => {
    expect(sqlText).toContain('agent_worker');
  });

  test('SQL creates agent_email_ingest role with LOGIN', () => {
    expect(sqlText).toContain('agent_email_ingest');
    expect(sqlText).toContain('LOGIN');
  });

  test('SQL grants CONNECT on superfield_app to agent_email_ingest', () => {
    expect(sqlText).toContain('GRANT CONNECT ON DATABASE superfield_app TO agent_email_ingest');
  });

  test('SQL script is idempotent (uses IF NOT EXISTS guards)', () => {
    expect(sqlText).toContain('IF NOT EXISTS');
  });
});

// ---------------------------------------------------------------------------
// dev-seed-worker-credentials.ts module structure
// ---------------------------------------------------------------------------

describe('dev-seed-worker-credentials.ts', () => {
  const seedText = readFileSync(
    join(import.meta.dirname, '../../../../scripts/dev-seed-worker-credentials.ts'),
    'utf-8',
  );

  test('seed script imports encryptField from core', () => {
    expect(seedText).toContain("from '../packages/core/encryption'");
  });

  test('seed script imports storeWorkerCredential from db', () => {
    expect(seedText).toContain('storeWorkerCredential');
  });

  test('seed script uses AGENT_TYPE env var', () => {
    expect(seedText).toContain('process.env.AGENT_TYPE');
  });

  test('seed script sets a 1-year expiry for dev credentials', () => {
    expect(seedText).toContain('365');
  });

  test('seed script uses worker_credential as the entity type for encryption', () => {
    expect(seedText).toContain('worker_credential');
  });
});

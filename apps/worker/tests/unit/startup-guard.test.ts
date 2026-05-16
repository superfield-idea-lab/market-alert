/**
 * Unit tests for startup-guard.ts
 *
 * Blueprint: Phase 1 — Linkerd mTLS and machine tokens for workers.
 *
 * Tests the credential guard that aborts a worker process when forbidden
 * database env vars (DATABASE_URL, PGPASSWORD, PGHOST, PGUSER, PGDATABASE)
 * are detected in the environment.
 *
 * No mocks. Tests use plain objects as the env argument.
 */

import { describe, it, expect } from 'vitest';
import {
  checkStartupGuard,
  assertNoDatabaseCredentials,
  FORBIDDEN_DB_ENV_VARS,
} from '../../src/startup-guard';

// ---------------------------------------------------------------------------
// checkStartupGuard — pure function, no side effects
// ---------------------------------------------------------------------------

describe('checkStartupGuard', () => {
  it('returns ok:true when no forbidden vars are present', () => {
    const result = checkStartupGuard({ WORKER_TOKEN: 'tok_abc123' });
    expect(result.ok).toBe(true);
    expect(result.detected).toHaveLength(0);
  });

  it('returns ok:true for an empty environment', () => {
    const result = checkStartupGuard({});
    expect(result.ok).toBe(true);
    expect(result.detected).toHaveLength(0);
  });

  it('detects DATABASE_URL', () => {
    const result = checkStartupGuard({ DATABASE_URL: 'postgres://user:pass@host/db' });
    expect(result.ok).toBe(false);
    expect(result.detected).toContain('DATABASE_URL');
  });

  it('detects PGPASSWORD', () => {
    const result = checkStartupGuard({ PGPASSWORD: 'secret' });
    expect(result.ok).toBe(false);
    expect(result.detected).toContain('PGPASSWORD');
  });

  it('detects PGHOST', () => {
    const result = checkStartupGuard({ PGHOST: 'postgres' });
    expect(result.ok).toBe(false);
    expect(result.detected).toContain('PGHOST');
  });

  it('detects PGUSER', () => {
    const result = checkStartupGuard({ PGUSER: 'superfield' });
    expect(result.ok).toBe(false);
    expect(result.detected).toContain('PGUSER');
  });

  it('detects PGDATABASE', () => {
    const result = checkStartupGuard({ PGDATABASE: 'superfield' });
    expect(result.ok).toBe(false);
    expect(result.detected).toContain('PGDATABASE');
  });

  it('detects multiple forbidden vars at once', () => {
    const result = checkStartupGuard({
      DATABASE_URL: 'postgres://user:pass@host/db',
      PGPASSWORD: 'secret',
      PGHOST: 'postgres',
    });
    expect(result.ok).toBe(false);
    expect(result.detected).toContain('DATABASE_URL');
    expect(result.detected).toContain('PGPASSWORD');
    expect(result.detected).toContain('PGHOST');
    expect(result.detected).toHaveLength(3);
  });

  it('ignores vars that are set to empty string', () => {
    // An empty string is treated as "not injected" — the guard only fires
    // when a var is non-empty so that partially-populated secrets don't
    // trigger a false positive.
    const result = checkStartupGuard({ DATABASE_URL: '' });
    expect(result.ok).toBe(true);
    expect(result.detected).toHaveLength(0);
  });

  it('does not flag WORKER_TOKEN or unrelated env vars', () => {
    const result = checkStartupGuard({
      WORKER_TOKEN: 'tok_abc123',
      NODE_ENV: 'production',
      PORT: '3000',
    });
    expect(result.ok).toBe(true);
  });

  it('covers all five forbidden vars via FORBIDDEN_DB_ENV_VARS constant', () => {
    // Ensure the constant lists exactly the vars we test for so it doesn't
    // silently drift.
    expect(FORBIDDEN_DB_ENV_VARS).toEqual([
      'DATABASE_URL',
      'PGPASSWORD',
      'PGHOST',
      'PGUSER',
      'PGDATABASE',
    ]);
  });
});

// ---------------------------------------------------------------------------
// assertNoDatabaseCredentials — side-effecting wrapper
// ---------------------------------------------------------------------------

describe('assertNoDatabaseCredentials', () => {
  it('does not call process.exit when no forbidden vars are present', () => {
    // Use a controlled env object with no forbidden vars.
    // We verify that no error is logged and exit is not called by the
    // absence of thrown errors and by checking the logger.
    const log: string[] = [];
    const logger = { error: (msg: string) => log.push(msg) };

    // Should not throw — if process.exit were called it would terminate
    // the vitest process. We rely on the implementation injecting a
    // fake process.exit via the env parameter in these tests to avoid
    // that. For the "happy path" test we just confirm no log is emitted.
    assertNoDatabaseCredentials({ WORKER_TOKEN: 'tok_abc123' }, logger);
    expect(log).toHaveLength(0);
  });

  it('logs an error message that names the detected vars when DATABASE_URL is set', () => {
    // Override process.exit to prevent test process termination.
    const originalExit = process.exit;
    const exitCodes: number[] = [];
    // Temporarily replace process.exit with a throwing stub so the function
    // terminates without killing the test runner.
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0));
      throw new Error(`process.exit(${code}) called`);
    }) as typeof process.exit;

    const log: string[] = [];
    const logger = { error: (msg: string) => log.push(msg) };

    try {
      assertNoDatabaseCredentials({ DATABASE_URL: 'postgres://user:pass@host/db' }, logger);
    } catch {
      // expected — process.exit throws in this test
    } finally {
      process.exit = originalExit;
    }

    expect(exitCodes).toEqual([1]);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('DATABASE_URL');
    expect(log[0]).toContain('WORKER_TOKEN');
  });

  it('includes all detected var names in the error message', () => {
    const originalExit = process.exit;
    const exitCodes: number[] = [];
    process.exit = ((code?: number | string | null) => {
      exitCodes.push(Number(code ?? 0));
      throw new Error(`process.exit(${code}) called`);
    }) as typeof process.exit;

    const log: string[] = [];
    const logger = { error: (msg: string) => log.push(msg) };

    try {
      assertNoDatabaseCredentials(
        { DATABASE_URL: 'postgres://x', PGPASSWORD: 'y', PGDATABASE: 'db' },
        logger,
      );
    } catch {
      // expected
    } finally {
      process.exit = originalExit;
    }

    expect(exitCodes).toEqual([1]);
    expect(log[0]).toContain('DATABASE_URL');
    expect(log[0]).toContain('PGPASSWORD');
    expect(log[0]).toContain('PGDATABASE');
  });
});

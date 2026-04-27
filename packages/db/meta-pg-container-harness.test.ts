/**
 * Meta smoke test for the pg-container harness itself.
 *
 * This test's only job is to prove "the Postgres test harness is alive."
 * It starts an ephemeral container, checks returned metadata looks sane,
 * establishes a real SQL connection, runs SELECT 1, and shuts down cleanly.
 *
 * It is intentionally isolated from higher-level suites so it can fail
 * independently and provide an early CI signal when the harness is broken.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';

let pg: PgContainer;

beforeAll(async () => {
  pg = await startPostgres();
}, 60_000);

afterAll(async () => {
  await pg?.stop();
});

describe('pg-container harness smoke test', () => {
  it('returns a container id', () => {
    expect(typeof pg.containerId).toBe('string');
    expect(pg.containerId.length).toBeGreaterThan(0);
  });

  it('returns a valid postgres:// url', () => {
    expect(pg.url).toMatch(/^postgres:\/\//);
    const u = new URL(pg.url);
    const port = parseInt(u.port, 10);
    expect(Number.isFinite(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  it('accepts a real SQL connection and runs SELECT 1', async () => {
    const sql = postgres(pg.url, { connect_timeout: 10 });
    try {
      const rows = await sql<{ result: number }[]>`SELECT 1 AS result`;
      expect(rows).toHaveLength(1);
      expect(rows[0].result).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('exposes a stop() function', () => {
    expect(typeof pg.stop).toBe('function');
  });
});

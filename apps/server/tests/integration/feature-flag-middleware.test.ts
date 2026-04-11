/**
 * Integration tests for the feature-flag evaluation middleware.
 *
 * Runs against a real Postgres container. No mocks.
 *
 * Acceptance criteria covered:
 *   - requireFlag returns null (allow) when flag state = 'enabled'
 *   - requireFlag returns 404 Response when flag state = 'disabled'
 *   - requireFlag returns 404 Response when flag row does not exist
 *   - Direct DB state change is immediately visible to subsequent requireFlag calls
 *   - Scheduler sweep (disableFlag) causes requireFlag to return 404
 *
 * Test plan items:
 *   - Integration: disable a flag, assert request to gated route returns 404/disabled response
 *   - Integration: re-enable flag, assert request succeeds (requireFlag returns null)
 *   - Integration: scheduler flips flag to disabled at scheduled_disable_at
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { migrate } from '../../../../packages/db/index';
import {
  upsertFlag,
  setFlagState,
  disableFlag,
  getFlagsDueForDisable,
} from '../../../../packages/db/feature-flags';
import { requireFlag, isFlagEnabled } from '../../src/security/feature-flag-middleware';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// isFlagEnabled
// ---------------------------------------------------------------------------

describe('isFlagEnabled', () => {
  test('returns true for the assemblyai_transcription seed row (state: enabled)', async () => {
    const enabled = await isFlagEnabled('assemblyai_transcription', sql);
    expect(enabled).toBe(true);
  });

  test('returns false when flag is disabled', async () => {
    await upsertFlag({ name: 'mw-enabled-test', state: 'disabled', owner: 'test' }, sql);
    const enabled = await isFlagEnabled('mw-enabled-test', sql);
    expect(enabled).toBe(false);
    await sql`DELETE FROM feature_flags WHERE name = 'mw-enabled-test'`;
  });

  test('returns false when flag does not exist', async () => {
    const enabled = await isFlagEnabled('completely-missing-flag', sql);
    expect(enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireFlag — enabled flag
// ---------------------------------------------------------------------------

describe('requireFlag — enabled flag', () => {
  test('returns null when flag state is "enabled" (request proceeds)', async () => {
    await upsertFlag({ name: 'mw-req-enabled', state: 'enabled', owner: 'test' }, sql);
    const guard = await requireFlag('mw-req-enabled', sql);
    expect(guard).toBeNull();
    await sql`DELETE FROM feature_flags WHERE name = 'mw-req-enabled'`;
  });
});

// ---------------------------------------------------------------------------
// requireFlag — disabled flag
// ---------------------------------------------------------------------------

describe('requireFlag — disabled flag (integration: disable then assert 404)', () => {
  test('returns 404 Response when flag is disabled', async () => {
    await upsertFlag({ name: 'mw-req-disabled', state: 'disabled', owner: 'test' }, sql);

    const guard = await requireFlag('mw-req-disabled', sql);

    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(404);

    const body = (await guard!.json()) as { error: string; flag: string };
    expect(body.error).toBe('Feature not available');
    expect(body.flag).toBe('mw-req-disabled');

    await sql`DELETE FROM feature_flags WHERE name = 'mw-req-disabled'`;
  });

  test('returns 404 Response when flag does not exist', async () => {
    const guard = await requireFlag('flag-that-does-not-exist', sql);
    expect(guard).not.toBeNull();
    expect(guard!.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Direct DB toggle round-trip
// ---------------------------------------------------------------------------

describe('direct DB toggle (no deploy required)', () => {
  test('disabling and re-enabling a flag is immediately visible', async () => {
    await upsertFlag({ name: 'mw-toggle-roundtrip', state: 'enabled', owner: 'test' }, sql);

    // Enabled → guard is null
    expect(await requireFlag('mw-toggle-roundtrip', sql)).toBeNull();

    // Disable via direct DB update
    await setFlagState('mw-toggle-roundtrip', 'disabled', sql);

    // Disabled → guard returns 404
    const guardDisabled = await requireFlag('mw-toggle-roundtrip', sql);
    expect(guardDisabled).not.toBeNull();
    expect(guardDisabled!.status).toBe(404);

    // Re-enable via direct DB update
    await setFlagState('mw-toggle-roundtrip', 'enabled', sql);

    // Back to enabled → guard is null again
    expect(await requireFlag('mw-toggle-roundtrip', sql)).toBeNull();

    await sql`DELETE FROM feature_flags WHERE name = 'mw-toggle-roundtrip'`;
  });
});

// ---------------------------------------------------------------------------
// Scheduler sweep causes middleware to return 404
// ---------------------------------------------------------------------------

describe('scheduler flips flag to disabled at scheduled_disable_at', () => {
  test('after cron sweep, requireFlag returns 404 for the flipped flag', async () => {
    const pastDate = new Date(Date.now() - 5_000); // 5 seconds ago

    await upsertFlag(
      {
        name: 'mw-scheduled-disable',
        state: 'enabled',
        owner: 'test',
        scheduled_disable_at: pastDate,
      },
      sql,
    );

    // Before sweep: flag is enabled → null guard
    expect(await requireFlag('mw-scheduled-disable', sql)).toBeNull();

    // Simulate cron sweep
    const due = await getFlagsDueForDisable(sql);
    for (const flag of due.filter((f) => f.name === 'mw-scheduled-disable')) {
      await disableFlag(flag.name, sql);
    }

    // After sweep: flag is disabled → 404 guard
    const guardAfterSweep = await requireFlag('mw-scheduled-disable', sql);
    expect(guardAfterSweep).not.toBeNull();
    expect(guardAfterSweep!.status).toBe(404);

    await sql`DELETE FROM feature_flags WHERE name = 'mw-scheduled-disable'`;
  });
});

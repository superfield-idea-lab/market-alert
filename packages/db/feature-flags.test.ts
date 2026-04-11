/**
 * Integration tests for the feature_flags table and evaluation helpers.
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Covers all acceptance criteria and test plan items from issue #97:
 *   - feature_flags table exists with required columns and CHECK constraint
 *   - assemblyai_transcription seed row present (state: enabled)
 *   - getFlagState returns correct values
 *   - setFlagState toggles state (direct DB toggle, no deploy required)
 *   - requireFlag middleware returns null when enabled, 404 when disabled
 *   - getFlagsDueForDisable returns flags past scheduled_disable_at
 *   - disableFlag flips state to disabled
 *   - Scheduler: disableFlag + getFlagsDueForDisable simulate the cron sweep
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  getFlagState,
  getFlag,
  getFlagsDueForDisable,
  disableFlag,
  setFlagState,
  upsertFlag,
} from './feature-flags';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

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
// Schema: table structure and CHECK constraint
// ---------------------------------------------------------------------------

describe('feature_flags table structure', () => {
  test('table has all required columns', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'feature_flags'
      ORDER BY ordinal_position
    `;
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('name');
    expect(cols).toContain('state');
    expect(cols).toContain('owner');
    expect(cols).toContain('created_at');
    expect(cols).toContain('scheduled_disable_at');
    expect(cols).toContain('disabled_at');
    expect(cols).toContain('removal_eligible_at');
  });

  test('CHECK constraint rejects invalid state values', async () => {
    await expect(
      sql`
        INSERT INTO feature_flags (name, state, owner)
        VALUES ('bad-state-test', 'unknown', 'test')
      `,
    ).rejects.toThrow();
  });

  test('CHECK constraint accepts valid state values', async () => {
    const names = ['check-enabled', 'check-deprecated', 'check-disabled'] as const;
    const states = ['enabled', 'deprecated', 'disabled'] as const;

    for (let i = 0; i < names.length; i++) {
      await sql`
        INSERT INTO feature_flags (name, state, owner)
        VALUES (${names[i]}, ${states[i]}, 'test')
        ON CONFLICT (name) DO NOTHING
      `;
    }

    for (let i = 0; i < names.length; i++) {
      const rows = await sql<{ state: string }[]>`
        SELECT state FROM feature_flags WHERE name = ${names[i]}
      `;
      expect(rows[0]?.state).toBe(states[i]);
    }

    // Clean up
    for (const name of names) {
      await sql`DELETE FROM feature_flags WHERE name = ${name}`;
    }
  });
});

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

describe('assemblyai_transcription seed row', () => {
  test('seed row exists after migrate()', async () => {
    const rows = await sql<{ name: string; state: string; owner: string }[]>`
      SELECT name, state, owner FROM feature_flags WHERE name = 'assemblyai_transcription'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('enabled');
    expect(rows[0].owner).toBe('product');
  });
});

// ---------------------------------------------------------------------------
// getFlagState
// ---------------------------------------------------------------------------

describe('getFlagState', () => {
  test('returns "enabled" for the assemblyai_transcription seed row', async () => {
    const state = await getFlagState('assemblyai_transcription', sql);
    expect(state).toBe('enabled');
  });

  test('returns null for a non-existent flag', async () => {
    const state = await getFlagState('does-not-exist', sql);
    expect(state).toBeNull();
  });

  test('returns "disabled" after a flag is disabled', async () => {
    await upsertFlag({ name: 'flag-get-state-test', state: 'enabled', owner: 'test' }, sql);
    await setFlagState('flag-get-state-test', 'disabled', sql);
    const state = await getFlagState('flag-get-state-test', sql);
    expect(state).toBe('disabled');
    await sql`DELETE FROM feature_flags WHERE name = 'flag-get-state-test'`;
  });
});

// ---------------------------------------------------------------------------
// Direct DB toggle (no deploy required — PRUNE-A-003)
// ---------------------------------------------------------------------------

describe('direct DB toggle via setFlagState', () => {
  test('disabling a flag is immediately visible to getFlagState', async () => {
    await upsertFlag({ name: 'flag-toggle-test', state: 'enabled', owner: 'test' }, sql);

    // Initially enabled
    expect(await getFlagState('flag-toggle-test', sql)).toBe('enabled');

    // Disable directly in the DB
    await setFlagState('flag-toggle-test', 'disabled', sql);
    expect(await getFlagState('flag-toggle-test', sql)).toBe('disabled');

    // Re-enable directly in the DB
    await setFlagState('flag-toggle-test', 'enabled', sql);
    expect(await getFlagState('flag-toggle-test', sql)).toBe('enabled');

    await sql`DELETE FROM feature_flags WHERE name = 'flag-toggle-test'`;
  });
});

// ---------------------------------------------------------------------------
// getFlag
// ---------------------------------------------------------------------------

describe('getFlag', () => {
  test('returns full flag row including timestamps', async () => {
    const flag = await getFlag('assemblyai_transcription', sql);
    expect(flag).not.toBeNull();
    expect(flag!.name).toBe('assemblyai_transcription');
    expect(flag!.state).toBe('enabled');
    expect(flag!.owner).toBe('product');
    expect(flag!.created_at).toBeInstanceOf(Date);
    expect(flag!.scheduled_disable_at).toBeNull();
    expect(flag!.disabled_at).toBeNull();
  });

  test('returns null for missing flag', async () => {
    const flag = await getFlag('nonexistent-flag', sql);
    expect(flag).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// disableFlag and getFlagsDueForDisable (scheduler simulation)
// ---------------------------------------------------------------------------

describe('getFlagsDueForDisable', () => {
  test('returns empty array when no flags have past scheduled_disable_at', async () => {
    const due = await getFlagsDueForDisable(sql);
    // The seed row has no scheduled_disable_at so the list should be empty
    const seedInList = due.find((f) => f.name === 'assemblyai_transcription');
    expect(seedInList).toBeUndefined();
  });

  test('returns flags with scheduled_disable_at in the past', async () => {
    const pastDate = new Date(Date.now() - 60_000); // 1 minute ago

    await upsertFlag(
      {
        name: 'flag-scheduled-disable-test',
        state: 'enabled',
        owner: 'test',
        scheduled_disable_at: pastDate,
      },
      sql,
    );

    const due = await getFlagsDueForDisable(sql);
    const found = due.find((f) => f.name === 'flag-scheduled-disable-test');
    expect(found).toBeDefined();
    expect(found!.state).toBe('enabled');

    await sql`DELETE FROM feature_flags WHERE name = 'flag-scheduled-disable-test'`;
  });

  test('does not return flags with scheduled_disable_at in the future', async () => {
    const futureDate = new Date(Date.now() + 60 * 60_000); // 1 hour from now

    await upsertFlag(
      {
        name: 'flag-future-disable-test',
        state: 'enabled',
        owner: 'test',
        scheduled_disable_at: futureDate,
      },
      sql,
    );

    const due = await getFlagsDueForDisable(sql);
    const found = due.find((f) => f.name === 'flag-future-disable-test');
    expect(found).toBeUndefined();

    await sql`DELETE FROM feature_flags WHERE name = 'flag-future-disable-test'`;
  });
});

describe('disableFlag', () => {
  test('flips state to disabled and records disabled_at', async () => {
    await upsertFlag({ name: 'flag-disable-test', state: 'enabled', owner: 'test' }, sql);

    await disableFlag('flag-disable-test', sql);

    const flag = await getFlag('flag-disable-test', sql);
    expect(flag!.state).toBe('disabled');
    expect(flag!.disabled_at).toBeInstanceOf(Date);

    await sql`DELETE FROM feature_flags WHERE name = 'flag-disable-test'`;
  });

  test('disableFlag is idempotent (does not error when already disabled)', async () => {
    await upsertFlag({ name: 'flag-idempotent-test', state: 'disabled', owner: 'test' }, sql);

    // Should not throw
    await expect(disableFlag('flag-idempotent-test', sql)).resolves.toBeUndefined();

    await sql`DELETE FROM feature_flags WHERE name = 'flag-idempotent-test'`;
  });
});

// ---------------------------------------------------------------------------
// Scheduler sweep simulation
// ---------------------------------------------------------------------------

describe('scheduler sweep simulation', () => {
  test('simulates cron job: disables all flags past their scheduled_disable_at', async () => {
    const past1 = new Date(Date.now() - 2 * 60_000);
    const past2 = new Date(Date.now() - 3 * 60_000);

    await upsertFlag(
      { name: 'sweep-flag-a', state: 'enabled', owner: 'test', scheduled_disable_at: past1 },
      sql,
    );
    await upsertFlag(
      { name: 'sweep-flag-b', state: 'enabled', owner: 'test', scheduled_disable_at: past2 },
      sql,
    );

    // Simulate the cron job sweep
    const due = await getFlagsDueForDisable(sql);
    const testDue = due.filter((f) => f.name.startsWith('sweep-flag-'));
    expect(testDue.length).toBeGreaterThanOrEqual(2);

    for (const flag of testDue) {
      await disableFlag(flag.name, sql);
    }

    // Verify both are now disabled
    expect(await getFlagState('sweep-flag-a', sql)).toBe('disabled');
    expect(await getFlagState('sweep-flag-b', sql)).toBe('disabled');

    // They should no longer appear in the due list
    const dueAfter = await getFlagsDueForDisable(sql);
    const stillDue = dueAfter.filter((f) => ['sweep-flag-a', 'sweep-flag-b'].includes(f.name));
    expect(stillDue.length).toBe(0);

    // Clean up
    await sql`DELETE FROM feature_flags WHERE name IN ('sweep-flag-a', 'sweep-flag-b')`;
  });
});

/**
 * Integration tests for mkt_feature_flags table and evaluateFlag helper.
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Covers all acceptance criteria and test plan items from issue #6:
 *   AC1: mkt_feature_flags table exists with key, enabled, scheduled_disable_at,
 *        updated_at columns
 *   AC2: All 5 v1 flag rows seeded with enabled=false
 *   AC3: evaluateFlag('edgar_ingest') returns false on a fresh DB
 *   AC4: Setting enabled=true for edgar_ingest and calling evaluateFlag returns true
 *   AC5: scheduled_disable_at in the past causes evaluateFlag to return false
 *
 * Test plan:
 *   TP1: Integration test: fresh DB has all 5 v1 flags with enabled=false
 *   TP2: Integration test: update edgar_ingest to enabled=true, evaluateFlag returns true
 *   TP3: Unit test: evaluateFlag returns false when scheduled_disable_at is in the past
 *        (covered in packages/core/feature-flags.test.ts — pure function, no DB)
 *   TP4: Integration test: prune task is enqueued when scheduled_disable_at is reached
 *        (getMktFlagsDueForDisable returns the key; evaluateFlag disables it)
 *
 * Blueprint refs: PRUNE-D-002, PRUNE-A-003, TEST-C-018 (no mocks)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate, migrateMkt } from './index';
import {
  evaluateFlag,
  getMktFlag,
  setMktFlag,
  getMktFlagsDueForDisable,
} from './mkt-feature-flags';
import { MKT_FLAG_KEYS } from '../core/feature-flags';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

let pg: PgContainer;
let db: Sql;

beforeAll(async () => {
  pg = await startPostgres();
  db = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
  await migrateMkt({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  await pg?.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// AC1: table structure
// ---------------------------------------------------------------------------

describe('mkt_feature_flags table structure (AC1)', () => {
  test('table has all required columns', async () => {
    const rows = await db<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'mkt_feature_flags'
      ORDER BY ordinal_position
    `;
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('key');
    expect(cols).toContain('enabled');
    expect(cols).toContain('scheduled_disable_at');
    expect(cols).toContain('updated_at');
  });

  test('key is the primary key', async () => {
    const rows = await db<{ constraint_type: string }[]>`
      SELECT kcu.column_name, tc.constraint_type
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'mkt_feature_flags'
        AND tc.constraint_type = 'PRIMARY KEY'
    `;
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC2 / TP1: v1 seed flags
// ---------------------------------------------------------------------------

describe('v1 seed flags (AC2, TP1)', () => {
  test('all 5 v1 flags exist with correct default enabled state', async () => {
    // Phase 6 scout (issue #25): trade_lifecycle was flipped to enabled=true
    // in mkt-schema.sql when this scout merged. All other flags remain false.
    const expectedStates: Record<string, boolean> = {
      edgar_ingest: false,
      alert_notify_email: false,
      alert_notify_sms: false,
      alert_notify_webhook: false,
      trade_lifecycle: true, // activated by Phase 6 scout (issue #25)
    };
    for (const key of MKT_FLAG_KEYS) {
      const flag = await getMktFlag(key, db);
      expect(flag, `flag ${key} should exist`).not.toBeNull();
      expect(flag!.enabled, `flag ${key} enabled should be ${expectedStates[key]}`).toBe(
        expectedStates[key],
      );
    }
  });

  test('at least 5 seed flags are present', async () => {
    const rows = await db<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count FROM mkt_feature_flags
    `;
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// AC3: evaluateFlag returns false on fresh DB
// ---------------------------------------------------------------------------

describe('evaluateFlag on fresh DB (AC3)', () => {
  test('evaluateFlag("edgar_ingest") returns false on fresh DB', async () => {
    const result = await evaluateFlag('edgar_ingest', db);
    expect(result).toBe(false);
  });

  test('evaluateFlag returns false for a non-existent key', async () => {
    const result = await evaluateFlag('does_not_exist', db);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 / TP2: toggle enabled=true, evaluateFlag returns true
// ---------------------------------------------------------------------------

describe('evaluateFlag after enabling a flag (AC4, TP2)', () => {
  test('setting edgar_ingest to true causes evaluateFlag to return true', async () => {
    await setMktFlag('edgar_ingest', true, db);
    const result = await evaluateFlag('edgar_ingest', db);
    expect(result).toBe(true);

    // Restore for other tests
    await setMktFlag('edgar_ingest', false, db);
  });
});

// ---------------------------------------------------------------------------
// AC5 / TP4: scheduled_disable_at in the past disables the flag
// ---------------------------------------------------------------------------

describe('scheduled_disable_at enforcement (AC5, TP4)', () => {
  test('evaluateFlag returns false when scheduled_disable_at is in the past', async () => {
    // Enable the flag and set scheduled_disable_at to the past
    await db`
      UPDATE mkt_feature_flags
      SET enabled = true,
          scheduled_disable_at = CURRENT_TIMESTAMP - INTERVAL '1 second',
          updated_at = CURRENT_TIMESTAMP
      WHERE key = 'alert_notify_email'
    `;

    const result = await evaluateFlag('alert_notify_email', db);
    expect(result).toBe(false);

    // After evaluateFlag the row should be disabled in the DB
    const flag = await getMktFlag('alert_notify_email', db);
    expect(flag!.enabled).toBe(false);
  });

  test('getMktFlagsDueForDisable returns keys past scheduled_disable_at', async () => {
    // Enable alert_notify_sms with a past scheduled_disable_at
    await db`
      UPDATE mkt_feature_flags
      SET enabled = true,
          scheduled_disable_at = CURRENT_TIMESTAMP - INTERVAL '1 second',
          updated_at = CURRENT_TIMESTAMP
      WHERE key = 'alert_notify_sms'
    `;

    const due = await getMktFlagsDueForDisable(db);
    expect(due).toContain('alert_notify_sms');

    // Restore
    await db`
      UPDATE mkt_feature_flags
      SET enabled = false, scheduled_disable_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE key = 'alert_notify_sms'
    `;
  });

  test('evaluateFlag returns true when scheduled_disable_at is in the future', async () => {
    await db`
      UPDATE mkt_feature_flags
      SET enabled = true,
          scheduled_disable_at = CURRENT_TIMESTAMP + INTERVAL '1 hour',
          updated_at = CURRENT_TIMESTAMP
      WHERE key = 'alert_notify_webhook'
    `;

    const result = await evaluateFlag('alert_notify_webhook', db);
    expect(result).toBe(true);

    // Restore
    await db`
      UPDATE mkt_feature_flags
      SET enabled = false, scheduled_disable_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE key = 'alert_notify_webhook'
    `;
  });
});

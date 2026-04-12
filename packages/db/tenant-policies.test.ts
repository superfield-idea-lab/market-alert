/**
 * Integration tests for tenant_policies table and getTenantPolicy / upsertTenantPolicy.
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Covers acceptance criteria from issue #40:
 *   - Global default autolearn_cron_interval seed row is present
 *   - getTenantPolicy returns the global default when no tenant override exists
 *   - upsertTenantPolicy creates a tenant-specific override
 *   - getTenantPolicy resolves the tenant override over the global default
 *   - Duplicate cron firings within the same window produce exactly one task row (TQ-C-005)
 *   - Two workers competing for the same autolearn task — exactly one claim wins (TQ-C-001)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import { getTenantPolicy, upsertTenantPolicy } from './tenant-policies';
import { buildAutolearnIdempotencyKey } from '../../apps/server/src/cron/jobs/autolearn-gardening';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 10 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// tenant_policies table — schema
// ---------------------------------------------------------------------------

describe('tenant_policies table structure', () => {
  test('table exists and has required columns', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'tenant_policies'
      ORDER BY ordinal_position
    `;
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('key');
    expect(cols).toContain('value');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  test('global default autolearn_cron_interval seed row is present', async () => {
    const [row] = await sql<{ key: string; value: string; tenant_id: string | null }[]>`
      SELECT key, value, tenant_id
      FROM tenant_policies
      WHERE key = 'autolearn_cron_interval' AND tenant_id IS NULL
    `;
    expect(row).toBeDefined();
    expect(row.value).toBe('*/15 * * * *');
    expect(row.tenant_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getTenantPolicy — resolution order
// ---------------------------------------------------------------------------

describe('getTenantPolicy', () => {
  test('returns the global default when no tenant-specific row exists', async () => {
    const value = await getTenantPolicy('autolearn_cron_interval', null, sql);
    expect(value).toBe('*/15 * * * *');
  });

  test('returns null for an unknown key', async () => {
    const value = await getTenantPolicy('unknown_policy_key', null, sql);
    expect(value).toBeNull();
  });

  test('returns tenant-specific override over global default', async () => {
    const tenantId = `test-tenant-${Date.now()}`;
    await upsertTenantPolicy(
      { key: 'autolearn_cron_interval', value: '*/5 * * * *', tenantId },
      sql,
    );

    const value = await getTenantPolicy('autolearn_cron_interval', tenantId, sql);
    expect(value).toBe('*/5 * * * *');

    // Other tenants still see the global default.
    const globalValue = await getTenantPolicy('autolearn_cron_interval', 'other-tenant', sql);
    expect(globalValue).toBe('*/15 * * * *');
  });

  test('upsertTenantPolicy updates an existing row idempotently', async () => {
    const tenantId = `test-tenant-upsert-${Date.now()}`;
    await upsertTenantPolicy(
      { key: 'autolearn_cron_interval', value: '*/10 * * * *', tenantId },
      sql,
    );
    await upsertTenantPolicy(
      { key: 'autolearn_cron_interval', value: '*/20 * * * *', tenantId },
      sql,
    );

    const value = await getTenantPolicy('autolearn_cron_interval', tenantId, sql);
    expect(value).toBe('*/20 * * * *');
  });
});

// ---------------------------------------------------------------------------
// Autolearn idempotency key helpers
// ---------------------------------------------------------------------------

describe('buildAutolearnIdempotencyKey', () => {
  test('two calls within the same 15-minute window produce the same key', () => {
    const windowStart = new Date('2025-01-01T12:00:00Z');
    const withinWindow = new Date('2025-01-01T12:14:59Z');
    const key1 = buildAutolearnIdempotencyKey(windowStart);
    const key2 = buildAutolearnIdempotencyKey(withinWindow);
    expect(key1).toBe(key2);
  });

  test('calls in different 15-minute windows produce different keys', () => {
    const window1 = new Date('2025-01-01T12:00:00Z');
    const window2 = new Date('2025-01-01T12:15:00Z');
    const key1 = buildAutolearnIdempotencyKey(window1);
    const key2 = buildAutolearnIdempotencyKey(window2);
    expect(key1).not.toBe(key2);
  });

  test('tenant-scoped keys are distinct from global keys', () => {
    const now = new Date('2025-01-01T12:00:00Z');
    const globalKey = buildAutolearnIdempotencyKey(now);
    const tenantKey = buildAutolearnIdempotencyKey(now, 15, 'tenant-abc');
    expect(globalKey).not.toBe(tenantKey);
    expect(tenantKey).toContain('tenant-abc');
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria: duplicate cron firings deduplicated (TQ-C-005)
// ---------------------------------------------------------------------------

describe('AUTOLEARN task deduplication (TQ-C-005)', () => {
  test('duplicate cron firings within the same window produce exactly one task row', async () => {
    const now = new Date();
    const idempotencyKey = `test-dedup-${buildAutolearnIdempotencyKey(now)}-${Date.now()}`;

    // Simulate two cron firings using the same idempotency key (ON CONFLICT DO UPDATE).
    await sql`
      INSERT INTO task_queue
        (idempotency_key, agent_type, job_type, payload, created_by)
      VALUES
        (${idempotencyKey}, 'autolearn', 'AUTOLEARN',
         ${sql.json({ window_start: now.toISOString() })}, 'cron:autolearn-gardening')
      ON CONFLICT (idempotency_key) DO UPDATE
        SET updated_at = task_queue.updated_at
    `;

    await sql`
      INSERT INTO task_queue
        (idempotency_key, agent_type, job_type, payload, created_by)
      VALUES
        (${idempotencyKey}, 'autolearn', 'AUTOLEARN',
         ${sql.json({ window_start: now.toISOString() })}, 'cron:autolearn-gardening')
      ON CONFLICT (idempotency_key) DO UPDATE
        SET updated_at = task_queue.updated_at
    `;

    const [countRow] = await sql<{ n: string }[]>`
      SELECT COUNT(*)::TEXT AS n FROM task_queue
      WHERE idempotency_key = ${idempotencyKey}
    `;
    expect(parseInt(countRow.n, 10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criteria: two workers compete — exactly one wins (TQ-C-001)
// ---------------------------------------------------------------------------

describe('AUTOLEARN task atomic claim (TQ-C-001)', () => {
  test('two workers competing for the same AUTOLEARN task — exactly one claim succeeds', async () => {
    const idempotencyKey = `test-claim-autolearn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Insert one pending AUTOLEARN task.
    await sql`
      INSERT INTO task_queue
        (idempotency_key, agent_type, job_type, payload, created_by)
      VALUES
        (${idempotencyKey}, 'autolearn', 'AUTOLEARN',
         ${sql.json({ tenant_id: null, window_start: new Date().toISOString() })},
         'cron:autolearn-gardening')
    `;

    // Helper: atomically claim the next autolearn task.
    async function claimOne(workerId: string): Promise<string | null> {
      const rows = await sql<{ id: string }[]>`
        UPDATE task_queue
        SET
          status           = 'claimed',
          claimed_by       = ${workerId},
          claimed_at       = NOW(),
          claim_expires_at = NOW() + INTERVAL '5 minutes',
          attempt          = attempt + 1,
          updated_at       = NOW()
        WHERE id = (
          SELECT id FROM task_queue
          WHERE agent_type = 'autolearn'
            AND status = 'pending'
            AND idempotency_key = ${idempotencyKey}
          ORDER BY priority ASC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `;
      return rows[0]?.id ?? null;
    }

    // Two workers race to claim.
    const [claim1, claim2] = await Promise.all([claimOne('worker-a'), claimOne('worker-b')]);

    const winners = [claim1, claim2].filter((c) => c !== null);
    // Exactly one worker must win.
    expect(winners.length).toBe(1);
  });
});

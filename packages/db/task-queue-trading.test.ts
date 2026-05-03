/**
 * Tests for Phase 0 trading platform task queue scaffold (issue #5).
 *
 * Validates:
 *  - TASK_TYPE_AGENT_MAP maps all 7 new trading task type constants
 *  - EDGAR_POLL idempotency key format is edgar_poll:<form_type>:<accession_number>
 *  - Enqueueing any new trading task type with a PII field in payload throws PayloadPiiError
 *  - EDGAR_POLL idempotency ensures only one row exists on double-enqueue
 *  - All four new task_queue_view_* views are queryable (integration)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate } from './index';
import {
  TaskType,
  TASK_TYPE_AGENT_MAP,
  PayloadPiiError,
  assertNoPiiInPayload,
  buildEdgarPollIdempotencyKey,
  enqueueTask,
} from './task-queue';

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — no database required
// ─────────────────────────────────────────────────────────────────────────────

describe('TASK_TYPE_AGENT_MAP — trading task types', () => {
  test('EDGAR_POLL maps to edgar_ingest', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.EDGAR_POLL]).toBe('edgar_ingest');
  });

  test('ALERT_ENRICH maps to enrichment', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.ALERT_ENRICH]).toBe('enrichment');
  });

  test('ALERT_DEDUP maps to enrichment', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.ALERT_DEDUP]).toBe('enrichment');
  });

  test('ALERT_NOTIFY maps to notification', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.ALERT_NOTIFY]).toBe('notification');
  });

  test('ALERT_SUPPLEMENT maps to enrichment', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.ALERT_SUPPLEMENT]).toBe('enrichment');
  });

  test('CORP_ACTION_ADVANCE maps to scheduler', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.CORP_ACTION_ADVANCE]).toBe('scheduler');
  });

  test('TRADE_SETTLE maps to scheduler', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.TRADE_SETTLE]).toBe('scheduler');
  });

  test('all 7 new trading task types are present in the map', () => {
    const tradingTypes: TaskType[] = [
      TaskType.EDGAR_POLL,
      TaskType.ALERT_ENRICH,
      TaskType.ALERT_DEDUP,
      TaskType.ALERT_NOTIFY,
      TaskType.ALERT_SUPPLEMENT,
      TaskType.CORP_ACTION_ADVANCE,
      TaskType.TRADE_SETTLE,
    ];
    for (const t of tradingTypes) {
      expect(TASK_TYPE_AGENT_MAP).toHaveProperty(t);
      expect(typeof TASK_TYPE_AGENT_MAP[t]).toBe('string');
      expect(TASK_TYPE_AGENT_MAP[t].length).toBeGreaterThan(0);
    }
  });
});

describe('buildEdgarPollIdempotencyKey', () => {
  test('formats as edgar_poll:<form_type>:<accession_number>', () => {
    const key = buildEdgarPollIdempotencyKey('8-K', '0001234567-24-000001');
    expect(key).toBe('edgar_poll:8-K:0001234567-24-000001');
  });

  test('includes both form_type and accession_number segments', () => {
    const key = buildEdgarPollIdempotencyKey('10-Q', '0009876543-23-099999');
    expect(key).toMatch(/^edgar_poll:[^:]+:[^:]+$/);
    expect(key).toContain('10-Q');
    expect(key).toContain('0009876543-23-099999');
  });
});

describe('assertNoPiiInPayload', () => {
  test('does not throw for a clean payload', () => {
    expect(() => assertNoPiiInPayload({ alert_id: 'uuid-abc', form_type: '8-K' })).not.toThrow();
  });

  test('throws PayloadPiiError when payload contains "email" field', () => {
    expect(() => assertNoPiiInPayload({ alert_id: 'uuid-abc', email: 'user@example.com' })).toThrow(
      PayloadPiiError,
    );
  });

  test('throws PayloadPiiError when payload contains "phone" field', () => {
    expect(() => assertNoPiiInPayload({ phone: '555-1234' })).toThrow(PayloadPiiError);
  });

  test('throws PayloadPiiError when payload contains "ssn" field', () => {
    expect(() => assertNoPiiInPayload({ ssn: '123-45-6789' })).toThrow(PayloadPiiError);
  });

  test('PayloadPiiError exposes the offending field name', () => {
    let caught: unknown;
    try {
      assertNoPiiInPayload({ email: 'x@y.com' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PayloadPiiError);
    expect((caught as PayloadPiiError).field).toBe('email');
  });

  test('case-insensitive: "Email" field is rejected', () => {
    expect(() => assertNoPiiInPayload({ Email: 'x@y.com' })).toThrow(PayloadPiiError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests — real PostgreSQL instance
// ─────────────────────────────────────────────────────────────────────────────

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 5 });
  await migrate({ databaseUrl: pg.url });
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await pg?.stop();
});

describe('EDGAR_POLL idempotency (integration)', () => {
  test('enqueueing the same EDGAR_POLL task twice yields one row (ON CONFLICT DO NOTHING)', async () => {
    const formType = '8-K';
    const accessionNumber = '0001234567-24-000001';
    const ikey = buildEdgarPollIdempotencyKey(formType, accessionNumber);
    const agentType = TASK_TYPE_AGENT_MAP[TaskType.EDGAR_POLL];

    // Insert directly using the test's sql connection (bypasses global pool).
    // ON CONFLICT DO NOTHING is the idempotency guarantee (TQ-P-003).
    const insertOnce = () =>
      sql`
        INSERT INTO task_queue
          (idempotency_key, agent_type, job_type, payload, created_by)
        VALUES
          (${ikey}, ${agentType}, ${TaskType.EDGAR_POLL},
           ${{ alert_id: 'test-uuid', form_type: formType, accession_number: accessionNumber }}::jsonb,
           'test')
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
      `;

    const first = await insertOnce();
    const second = await insertOnce();

    // Second insert is a no-op — returns no rows
    expect(second.count).toBe(0);

    // Exactly one row in the database
    const [{ count }] = await sql<[{ count: number }]>`
      SELECT COUNT(*)::INTEGER AS count FROM task_queue WHERE idempotency_key = ${ikey}
    `;
    expect(count).toBe(1);
    // The original row's id is preserved
    expect(first.length).toBe(1);
  }, 30_000);
});

describe('PII validator at enqueue (integration)', () => {
  test('enqueueing EDGAR_POLL with email field in payload throws PayloadPiiError', async () => {
    await expect(
      enqueueTask({
        idempotency_key: `edgar-pii-test-${Date.now()}`,
        agent_type: TASK_TYPE_AGENT_MAP[TaskType.EDGAR_POLL],
        job_type: TaskType.EDGAR_POLL,
        payload: { email: 'trader@example.com', accession_number: '0001234567-24-000002' },
        created_by: 'test',
      }),
    ).rejects.toThrow(PayloadPiiError);
  }, 15_000);

  test('enqueueing ALERT_ENRICH with phone field in payload throws PayloadPiiError', async () => {
    await expect(
      enqueueTask({
        idempotency_key: `enrich-pii-test-${Date.now()}`,
        agent_type: TASK_TYPE_AGENT_MAP[TaskType.ALERT_ENRICH],
        job_type: TaskType.ALERT_ENRICH,
        payload: { phone: '555-9999', alert_id: 'uuid-abc' },
        created_by: 'test',
      }),
    ).rejects.toThrow(PayloadPiiError);
  }, 15_000);
});

describe('task_queue_view_* trading views (integration)', () => {
  test('task_queue_view_edgar_ingest is queryable', async () => {
    const rows = await sql`SELECT * FROM task_queue_view_edgar_ingest LIMIT 1`;
    expect(Array.isArray(rows)).toBe(true);
  }, 15_000);

  test('task_queue_view_enrichment is queryable', async () => {
    const rows = await sql`SELECT * FROM task_queue_view_enrichment LIMIT 1`;
    expect(Array.isArray(rows)).toBe(true);
  }, 15_000);

  test('task_queue_view_notification is queryable', async () => {
    const rows = await sql`SELECT * FROM task_queue_view_notification LIMIT 1`;
    expect(Array.isArray(rows)).toBe(true);
  }, 15_000);

  test('task_queue_view_scheduler is queryable', async () => {
    const rows = await sql`SELECT * FROM task_queue_view_scheduler LIMIT 1`;
    expect(Array.isArray(rows)).toBe(true);
  }, 15_000);

  test('task_queue_view_edgar_ingest contains a row after inserting an edgar_ingest task', async () => {
    const ikey = `edgar-view-test-${Date.now()}`;
    const agentType = TASK_TYPE_AGENT_MAP[TaskType.EDGAR_POLL];

    // Insert into the underlying table and get back the id
    const [inserted] = await sql<[{ id: string }]>`
      INSERT INTO task_queue
        (idempotency_key, agent_type, job_type, payload, created_by)
      VALUES
        (${ikey}, ${agentType}, ${TaskType.EDGAR_POLL},
         ${{ alert_id: 'view-test-uuid', form_type: '10-K', accession_number: 'test-001' }}::jsonb,
         'test')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `;

    expect(inserted).toBeDefined();

    // The view should contain the same row
    const [row] = await sql`
      SELECT * FROM task_queue_view_edgar_ingest WHERE id = ${inserted.id}
    `;
    expect(row).toBeDefined();
    expect(row.agent_type).toBe('edgar_ingest');
  }, 30_000);
});

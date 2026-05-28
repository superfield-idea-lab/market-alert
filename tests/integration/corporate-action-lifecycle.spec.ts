/**
 * @file tests/integration/corporate-action-lifecycle.spec.ts
 *
 * Integration tests for the Corporate Action state machine — Phase 2 (issue #16).
 *
 * ## What this tests
 *
 * All acceptance criteria from issue #16:
 *   AC-1  Announced → Effective after cron runs (effective_date in the past)
 *   AC-2  Effective  → Closed  after cron runs (settlement_date in the past)
 *   AC-3  PATCH /advance returns 409 for illegal transitions
 *   AC-4  POST /dispute sets state=Disputed, requires non-empty reason
 *   AC-5  Every transition produces exactly one journal entry
 *   AC-6  Cron does not insert duplicate CORP_ACTION_ADVANCE tasks
 *   AC-7  Full Announced → Effective → Closed lifecycle with journal entries
 *
 * ## Test plan
 *
 *   TP-1  Spin up real Postgres via testcontainers; insert CorporateAction with
 *         effective_date = yesterday.
 *   TP-2  Run findCorporateActionsNeedingAdvance and assert one candidate; assert
 *         no duplicate on second call.
 *   TP-3  Call PATCH /internal/corporate-actions/:id/advance; assert state=Effective
 *         with one journal entry.
 *   TP-4  Insert another CorporateAction with settlement_date in the past and state
 *         Effective; run advance; assert state=Closed.
 *   TP-5  Call POST /internal/corporate-actions/:id/dispute; assert state=Disputed
 *         with journal entry; repeat with empty reason returns 422.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container via testcontainers.
 * Zero vi.fn, vi.mock, vi.spyOn.
 *
 * ## Canonical docs
 *
 * - packages/db/mkt-corporate-action-lifecycle.ts — state machine data access
 * - apps/server/src/api/corporate-action-lifecycle.ts — API handlers
 * - apps/server/src/cron/jobs/corp-action-advance-dispatch.ts — cron job
 * - packages/db/mkt-schema.sql — DDL
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import {
  findCorporateActionsNeedingAdvance,
  advanceCorporateAction,
  disputeCorporateAction,
  getCorporateActionJournal,
  getCorporateActionStateById,
  CorporateActionTransitionError,
  CorporateActionState,
} from '../../packages/db/mkt-corporate-action-lifecycle';
import { enqueueTask, TaskType, TASK_TYPE_AGENT_MAP } from '../../packages/db/task-queue';
import { handleCorporateActionLifecycleRequest } from '../../apps/server/src/api/corporate-action-lifecycle';
import type { AppState } from '../../apps/server/src/index';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const INTERNAL_TEST_TOKEN = 'lifecycle-test-secret-16';

const TEST_PASSWORDS = {
  app: 'app_test_pw_lc',
  audit: 'audit_test_pw_lc',
  analytics: 'analytics_test_pw_lc',
  dictionary: 'dict_test_pw_lc',
  email_ingest: 'email_ingest_test_pw_lc',
};

// Shared test state
let pg: PgContainer;
let sql: ReturnType<typeof postgres>;
let appState: AppState;

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  const appRwUrl = makeRoleUrl(pg.url, 'superfield_app', 'app_rw', TEST_PASSWORDS.app);
  sql = postgres(appRwUrl, { max: 5 });

  await migrate({ databaseUrl: appRwUrl });
  await migrateMkt({ databaseUrl: appRwUrl });

  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  process.env.ENCRYPTION_MASTER_KEY = 'b'.repeat(64);
  process.env.TEST_MODE = 'true';
  process.env.EDGAR_TEST_TOKEN = INTERNAL_TEST_TOKEN;
  process.env.INTERNAL_TEST_TOKEN = INTERNAL_TEST_TOKEN;
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env.ENCRYPTION_MASTER_KEY;
  delete process.env.TEST_MODE;
  delete process.env.EDGAR_TEST_TOKEN;
  delete process.env.INTERNAL_TEST_TOKEN;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a minimal CorporateAction row with the given state and dates.
 * Returns the inserted row id.
 */
async function insertCorporateAction(opts: {
  accession_number: string;
  state: string;
  effective_date?: string | null;
  settlement_date?: string | null;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO mkt_corporate_actions
      (idempotency_key, form_type, accession_number, cik, filing_date,
       filing_text, status, state, effective_date, settlement_date)
    VALUES
      (${'test:' + opts.accession_number}, '8-K', ${opts.accession_number},
       '0001234567', CURRENT_TIMESTAMP, 'encrypted-placeholder', 'raw',
       ${opts.state},
       ${opts.effective_date ?? null},
       ${opts.settlement_date ?? null})
    RETURNING id
  `;
  return rows[0].id;
}

function makeAdvanceRequest(id: string): Request {
  return new Request(`http://localhost/internal/corporate-actions/${id}/advance`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INTERNAL_TEST_TOKEN}`,
    },
  });
}

function makeDisputeRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost/internal/corporate-actions/${id}/dispute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INTERNAL_TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// TP-1 / TP-2: Schema and cron candidate query
// ---------------------------------------------------------------------------

describe('Schema: state machine columns and journal table (AC-7)', () => {
  test('mkt_corporate_actions has state column', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'mkt_corporate_actions'
        AND column_name = 'state'
    `;
    expect(rows).toHaveLength(1);
  });

  test('mkt_corporate_actions has effective_date and settlement_date columns', async () => {
    const cols = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'mkt_corporate_actions'
        AND column_name IN ('effective_date', 'settlement_date')
    `;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('effective_date');
    expect(names).toContain('settlement_date');
  });

  test('mkt_corporate_action_journal table exists', async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'mkt_corporate_action_journal'
    `;
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TP-2: Cron candidate query + duplicate task prevention (AC-1, AC-6)
// ---------------------------------------------------------------------------

describe('Cron candidate query and duplicate task prevention (AC-1, AC-6)', () => {
  let announcedId: string;

  beforeAll(async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    announcedId = await insertCorporateAction({
      accession_number: `0001-cron-advance-${Date.now()}`,
      state: 'Announced',
      effective_date: yesterdayStr,
    });
  });

  test('TP-2a: findCorporateActionsNeedingAdvance returns the announced row (AC-1)', async () => {
    const candidates = await findCorporateActionsNeedingAdvance(sql);
    const found = candidates.find((c) => c.id === announcedId);
    expect(found).toBeDefined();
    expect(found!.state).toBe('Announced');
  });

  test('TP-2b: after enqueuing CORP_ACTION_ADVANCE task, row is excluded on second query (AC-6)', async () => {
    await enqueueTask({
      idempotency_key: `corp-action-advance:${announcedId}`,
      agent_type: TASK_TYPE_AGENT_MAP[TaskType.CORP_ACTION_ADVANCE],
      job_type: TaskType.CORP_ACTION_ADVANCE,
      payload: { corporate_action_id: announcedId },
      created_by: 'test:cron',
      sql: sql as unknown as typeof import('../../packages/db/index').sql,
    });

    const candidates = await findCorporateActionsNeedingAdvance(sql);
    const found = candidates.find((c) => c.id === announcedId);
    expect(found).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TP-3: PATCH /advance — Announced → Effective (AC-1, AC-5)
// ---------------------------------------------------------------------------

describe('PATCH /advance: Announced → Effective (AC-1, AC-3, AC-5)', () => {
  let caId: string;

  beforeAll(async () => {
    caId = await insertCorporateAction({
      accession_number: `0002-advance-ann-${Date.now()}`,
      state: 'Announced',
    });
  });

  test('TP-3a: advance returns 200 with state=Effective', async () => {
    const req = makeAdvanceRequest(caId);
    const url = new URL(req.url);
    const resp = await handleCorporateActionLifecycleRequest(req, url, appState);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { id: string; state: string };
    expect(body.state).toBe('Effective');
    expect(body.id).toBe(caId);
  });

  test('TP-3b: state in DB is Effective (AC-1)', async () => {
    const row = await getCorporateActionStateById(caId, sql);
    expect(row).not.toBeNull();
    expect(row!.state).toBe(CorporateActionState.Effective);
  });

  test('TP-3c: journal entry with correct fields after Announced→Effective (AC-5)', async () => {
    const journal = await getCorporateActionJournal(caId, sql);
    // At this point we have at least the Announced→Effective entry
    const firstEntry = journal[0];
    expect(firstEntry.from_state).toBe('Announced');
    expect(firstEntry.to_state).toBe('Effective');
    expect(firstEntry.actor).toBe('system:corp-action-advance');
    expect(firstEntry.occurred_at).toBeInstanceOf(Date);
  });

  test('TP-3d: after Announced→Effective, advancing Effective→Closed succeeds, then Closed→x returns 409 (AC-3)', async () => {
    // First advance: Effective → Closed (legal)
    const req1 = makeAdvanceRequest(caId);
    const resp1 = await handleCorporateActionLifecycleRequest(req1, new URL(req1.url), appState);
    expect(resp1!.status).toBe(200);

    // Second advance: Closed → (no transition) → 409
    const req2 = makeAdvanceRequest(caId);
    const resp2 = await handleCorporateActionLifecycleRequest(req2, new URL(req2.url), appState);
    expect(resp2).not.toBeNull();
    expect(resp2!.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// TP-4: Full lifecycle Announced → Effective → Closed (AC-2, AC-7)
// ---------------------------------------------------------------------------

describe('Full lifecycle: Announced → Effective → Closed (AC-2, AC-7)', () => {
  let caId: string;

  beforeAll(async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    caId = await insertCorporateAction({
      accession_number: `0003-full-lifecycle-${Date.now()}`,
      state: 'Announced',
      effective_date: yesterdayStr,
      settlement_date: yesterdayStr,
    });
  });

  test('TP-4a: advance from Announced → Effective', async () => {
    const newState = await advanceCorporateAction(caId, 'test:actor', sql);
    expect(newState).toBe(CorporateActionState.Effective);
  });

  test('TP-4b: advance from Effective → Closed (AC-2)', async () => {
    const newState = await advanceCorporateAction(caId, 'test:actor', sql);
    expect(newState).toBe(CorporateActionState.Closed);
  });

  test('TP-4c: state in DB is Closed (AC-2, AC-7)', async () => {
    const row = await getCorporateActionStateById(caId, sql);
    expect(row!.state).toBe(CorporateActionState.Closed);
  });

  test('TP-4d: two journal entries for full lifecycle (AC-5, AC-7)', async () => {
    const journal = await getCorporateActionJournal(caId, sql);
    expect(journal).toHaveLength(2);
    expect(journal[0].from_state).toBe('Announced');
    expect(journal[0].to_state).toBe('Effective');
    expect(journal[1].from_state).toBe('Effective');
    expect(journal[1].to_state).toBe('Closed');
  });

  test('TP-4e: advance on Closed returns 409 (AC-3)', async () => {
    await expect(advanceCorporateAction(caId, 'test:actor', sql)).rejects.toBeInstanceOf(
      CorporateActionTransitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// TP-5: POST /dispute — force Disputed (AC-4, AC-5)
// ---------------------------------------------------------------------------

describe('POST /dispute: force Disputed (AC-4, AC-5)', () => {
  let caId: string;

  beforeAll(async () => {
    caId = await insertCorporateAction({
      accession_number: `0004-dispute-${Date.now()}`,
      state: 'Announced',
    });
  });

  test('TP-5a: dispute with valid reason returns 200 with state=Disputed (AC-4)', async () => {
    const req = makeDisputeRequest(caId, { reason: 'Regulatory review pending' });
    const url = new URL(req.url);
    const resp = await handleCorporateActionLifecycleRequest(req, url, appState);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    const body = (await resp!.json()) as { id: string; state: string };
    expect(body.state).toBe('Disputed');
  });

  test('TP-5b: state in DB is Disputed (AC-4)', async () => {
    const row = await getCorporateActionStateById(caId, sql);
    expect(row!.state).toBe(CorporateActionState.Disputed);
  });

  test('TP-5c: journal entry contains actor, from_state, to_state, reason (AC-5)', async () => {
    const journal = await getCorporateActionJournal(caId, sql);
    expect(journal).toHaveLength(1);
    expect(journal[0].to_state).toBe('Disputed');
    expect(journal[0].reason).toBe('Regulatory review pending');
    expect(journal[0].actor).toBe('system:admin-dispute');
  });

  test('TP-5d: dispute on already-Disputed returns 409 (AC-4)', async () => {
    const req = makeDisputeRequest(caId, { reason: 'another reason' });
    const url = new URL(req.url);
    const resp = await handleCorporateActionLifecycleRequest(req, url, appState);
    expect(resp!.status).toBe(409);
  });

  test('TP-5e: dispute with empty reason returns 422 (AC-4)', async () => {
    const newId = await insertCorporateAction({
      accession_number: `0005-dispute-empty-reason-${Date.now()}`,
      state: 'Announced',
    });
    const req = makeDisputeRequest(newId, { reason: '' });
    const url = new URL(req.url);
    const resp = await handleCorporateActionLifecycleRequest(req, url, appState);
    expect(resp!.status).toBe(422);
  });

  test('TP-5f: dispute with missing reason returns 422 (AC-4)', async () => {
    const newId = await insertCorporateAction({
      accession_number: `0006-dispute-no-reason-${Date.now()}`,
      state: 'Announced',
    });
    const req = makeDisputeRequest(newId, {});
    const url = new URL(req.url);
    const resp = await handleCorporateActionLifecycleRequest(req, url, appState);
    expect(resp!.status).toBe(422);
  });
});

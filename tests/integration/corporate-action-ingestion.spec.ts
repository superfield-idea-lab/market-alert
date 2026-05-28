/**
 * @file tests/integration/corporate-action-ingestion.spec.ts
 *
 * Integration tests for the POST /internal/ingestion/corporate-action endpoint.
 * Issue #49: Corporate Action ingestion API and mkt_corporate_actions table.
 *
 * ## What this tests
 *
 * All acceptance criteria from issue #49:
 *   AC-1  422 when required fields are missing or malformed (Zod validation)
 *   AC-2  filing_text stored as AES-256-GCM ciphertext (enc:v1: prefix)
 *   AC-3  Duplicate accession_number returns 200, exactly one row in DB
 *   AC-4  ALERT_ENRICH task exists after successful 201 response
 *   AC-5  Duplicate does not enqueue a second ALERT_ENRICH task
 *   AC-6  mkt-schema.sql contains authoritative CREATE TABLE for mkt_corporate_actions
 *   AC-7  Integration test against real Postgres: row count, encrypted field, task state
 *
 * ## Test plan
 *
 *   TP-1  Spin up real Postgres via testcontainers and apply mkt-schema.sql
 *   TP-2  POST valid body → assert 201, one row with enc:v1: filing_text, one ALERT_ENRICH task
 *   TP-3  POST same accession_number again → assert 200, still one row, no additional task
 *   TP-4  POST body missing required fields → assert 422 with structured error response
 *   TP-5  Decrypt stored filing_text and assert it matches the original plaintext
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container via testcontainers.
 * The handler is called directly (not mocked). Zero vi.fn, vi.mock, vi.spyOn.
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline
 * - apps/server/src/api/corporate-action-ingestion.ts — API endpoint
 * - packages/db/mkt-corporate-action.ts — CorporateAction schema
 * - packages/db/mkt-schema.sql — authoritative DDL
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import { handleCorporateActionIngestionRequest } from '../../apps/server/src/api/corporate-action-ingestion';
import { TaskType } from '../../packages/db/task-queue';
import { decryptField } from '../../packages/core/encryption';
import type { AppState } from '../../apps/server/src/index';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const EDGAR_TEST_TOKEN = 'corp-action-test-secret-49';
const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
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
  // 1. Start ephemeral Postgres container
  pg = await startPostgres();

  // 2. Provision roles and databases (app_rw, audit_w, etc.)
  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  // 3. Connect as app_rw for schema migration and direct assertions
  const appRwUrl = makeRoleUrl(pg.url, 'superfield_app', 'app_rw', TEST_PASSWORDS.app);
  sql = postgres(appRwUrl, { max: 5 });

  // 4. Apply base schema (includes task_queue DDL) then mkt-schema (mkt_corporate_actions)
  await migrate({ databaseUrl: appRwUrl });
  await migrateMkt({ databaseUrl: appRwUrl });

  // 5. Build a minimal AppState with the test DB sql pool
  appState = {
    sql: sql as unknown as typeof import('../../packages/db/index').sql,
    auditSql: sql as unknown as typeof import('../../packages/db/index').sql,
    analyticsSql: sql as unknown as typeof import('../../packages/db/index').sql,
    dictionarySql: sql as unknown as typeof import('../../packages/db/index').sql,
  };

  // 6. Set ENCRYPTION_MASTER_KEY so encryptField works in tests.
  // Must be a 64-char hex string (32 bytes) as required by LocalDevKmsBackend.
  process.env.ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
  // Set TEST_MODE and EDGAR_TEST_TOKEN so the handler accepts the token
  process.env.TEST_MODE = 'true';
  process.env.EDGAR_TEST_TOKEN = EDGAR_TEST_TOKEN;
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  delete process.env.ENCRYPTION_MASTER_KEY;
  delete process.env.TEST_MODE;
  delete process.env.EDGAR_TEST_TOKEN;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, token = EDGAR_TEST_TOKEN): Request {
  return new Request('http://localhost/internal/ingestion/corporate-action', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// TP-1: Schema migration — mkt-schema.sql contains mkt_corporate_actions DDL
// ---------------------------------------------------------------------------

describe('mkt-schema.sql authoritative DDL (AC-6)', () => {
  test('mkt_corporate_actions table exists after migrateMkt()', async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = 'mkt_corporate_actions'
    `;
    expect(rows).toHaveLength(1);
  });

  test('mkt_corporate_actions has idempotency_key UNIQUE constraint', async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'mkt_corporate_actions'
        AND indexdef ILIKE '%unique%'
    `;
    expect(rows.length).toBeGreaterThan(0);
    const idempotencyIndex = rows.find((r) => r.indexdef.includes('idempotency_key'));
    expect(idempotencyIndex).toBeDefined();
  });

  test('mkt_corporate_actions has filing_text column', async () => {
    const rows = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'mkt_corporate_actions'
        AND column_name = 'filing_text'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// TP-4: Zod validation — 422 on missing or malformed fields (AC-1)
// ---------------------------------------------------------------------------

describe('Zod validation returns 422 on invalid input (AC-1)', () => {
  test('missing accession_number returns 422', async () => {
    const req = makeRequest({
      form_type: '8-K',
      cik: '0001234567',
      filing_date: '2026-05-07T20:15:00Z',
      filing_text: '<entry>test</entry>',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(422);

    const body = (await response!.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe('Validation failed');
    expect(body.issues).toBeDefined();
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  test('missing form_type returns 422', async () => {
    const req = makeRequest({
      accession_number: '0001234567-26-000099',
      cik: '0001234567',
      filing_date: '2026-05-07T20:15:00Z',
      filing_text: '<entry>test</entry>',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(422);
  });

  test('missing cik returns 422', async () => {
    const req = makeRequest({
      accession_number: '0001234567-26-000099',
      form_type: '8-K',
      filing_date: '2026-05-07T20:15:00Z',
      filing_text: '<entry>test</entry>',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(422);
  });

  test('missing filing_date returns 422', async () => {
    const req = makeRequest({
      accession_number: '0001234567-26-000099',
      form_type: '8-K',
      cik: '0001234567',
      filing_text: '<entry>test</entry>',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(422);
  });

  test('missing filing_text returns 422', async () => {
    const req = makeRequest({
      accession_number: '0001234567-26-000099',
      form_type: '8-K',
      cik: '0001234567',
      filing_date: '2026-05-07T20:15:00Z',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(422);
  });

  test('empty string accession_number returns 422', async () => {
    const req = makeRequest({
      accession_number: '',
      form_type: '8-K',
      cik: '0001234567',
      filing_date: '2026-05-07T20:15:00Z',
      filing_text: '<entry>test</entry>',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(422);
  });

  test('completely empty body returns 422', async () => {
    const req = makeRequest({});
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(422);
  });

  test('non-object body returns 422', async () => {
    const req = makeRequest(['not', 'an', 'object']);
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(422);
  });

  test('unauthorized request returns 401 (not 422)', async () => {
    const req = makeRequest(
      {
        accession_number: '0001234567-26-000099',
        form_type: '8-K',
        cik: '0001234567',
        filing_date: '2026-05-07T20:15:00Z',
        filing_text: '<entry>test</entry>',
      },
      'wrong-token',
    );
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// TP-2: First insert — 201, encrypted filing_text, one ALERT_ENRICH task (AC-2, AC-4, AC-7)
// ---------------------------------------------------------------------------

describe('First insert: 201, encrypted filing_text, ALERT_ENRICH task (AC-2, AC-4, AC-7)', () => {
  const ACCESSION = '0009876543-26-000001';
  const PLAINTEXT =
    '<entry><title>TEST CORP — 8-K — 2026-05-01</title><id>urn:tag:sec.gov,2008:accession-number=0009876543-26-000001</id></entry>';

  test('TP-2a: POST valid body returns 201 with id', async () => {
    const req = makeRequest({
      accession_number: ACCESSION,
      form_type: '8-K',
      cik: '0009876543',
      issuer_name: 'Test Corp',
      filing_date: '2026-05-01T12:00:00Z',
      filing_text: PLAINTEXT,
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(201);

    const body = (await response!.json()) as { id: string };
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
  });

  test('TP-2b: mkt_corporate_actions row has AES-256-GCM ciphertext (AC-2)', async () => {
    const rows = await sql<{ id: string; filing_text: string; idempotency_key: string }[]>`
      SELECT id, filing_text, idempotency_key
      FROM mkt_corporate_actions
      WHERE accession_number = ${ACCESSION}
      LIMIT 1
    `;

    expect(rows).toHaveLength(1);
    const row = rows[0];

    // AC-2: filing_text must be AES-256-GCM ciphertext (enc:v1: prefix)
    expect(row.filing_text).toMatch(/^enc:v1:/);
    // It must NOT contain raw XML text
    expect(row.filing_text).not.toContain('<entry');
    // Idempotency key follows edgar:<accession_number>
    expect(row.idempotency_key).toBe(`edgar:${ACCESSION}`);
  });

  test('TP-5: decrypt filing_text restores original plaintext (AC-7)', async () => {
    const rows = await sql<{ filing_text: string }[]>`
      SELECT filing_text
      FROM mkt_corporate_actions
      WHERE accession_number = ${ACCESSION}
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);

    const decrypted = await decryptField('corporate_action', rows[0].filing_text);
    expect(decrypted).toBe(PLAINTEXT);
  });

  test('TP-2c: exactly one ALERT_ENRICH task after 201 (AC-4)', async () => {
    const caRows = await sql<{ id: string }[]>`
      SELECT id FROM mkt_corporate_actions
      WHERE accession_number = ${ACCESSION}
      LIMIT 1
    `;
    expect(caRows).toHaveLength(1);
    const corporateActionId = caRows[0].id;

    const enrichRows = await sql<{ id: string; payload: Record<string, unknown> }[]>`
      SELECT id, payload
      FROM task_queue
      WHERE job_type = ${TaskType.ALERT_ENRICH}
        AND payload->>'corporate_action_id' = ${corporateActionId}
    `;
    expect(enrichRows).toHaveLength(1);
    expect(enrichRows[0].payload.corporate_action_id).toBe(corporateActionId);
  });
});

// ---------------------------------------------------------------------------
// TP-3: Idempotency — duplicate accession_number (AC-3, AC-5)
// ---------------------------------------------------------------------------

describe('Idempotency: duplicate accession_number (AC-3, AC-5)', () => {
  const ACCESSION = '0009876543-26-000002';

  test('TP-3a: first call returns 201', async () => {
    const req = makeRequest({
      accession_number: ACCESSION,
      form_type: '8-K',
      cik: '0009876543',
      filing_date: '2026-05-02T12:00:00Z',
      filing_text: '<entry>first submission</entry>',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);
    expect(response!.status).toBe(201);
  });

  test('TP-3b: second call with same accession_number returns 200 (AC-3)', async () => {
    const req = makeRequest({
      accession_number: ACCESSION,
      form_type: '8-K',
      cik: '0009876543',
      filing_date: '2026-05-02T12:00:00Z',
      filing_text: '<entry>duplicate submission</entry>',
    });
    const url = new URL(req.url);
    const response = await handleCorporateActionIngestionRequest(req, url, appState);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);

    const body = (await response!.json()) as { id: string; duplicate: boolean };
    expect(body.duplicate).toBe(true);
    expect(body.id).toBeDefined();
  });

  test('TP-3c: exactly one row in mkt_corporate_actions (AC-3)', async () => {
    const countRows = await sql<{ c: string }[]>`
      SELECT COUNT(*)::TEXT AS c
      FROM mkt_corporate_actions
      WHERE accession_number = ${ACCESSION}
    `;
    expect(countRows[0].c).toBe('1');
  });

  test('TP-3d: no additional ALERT_ENRICH task enqueued on duplicate (AC-5)', async () => {
    // The idempotency key for ALERT_ENRICH is alert-enrich:edgar:<accession_number>
    // so the same key is used on both calls, ensuring ON CONFLICT DO UPDATE
    // returns the existing row without creating a duplicate.
    const taskRows = await sql<{ id: string }[]>`
      SELECT id
      FROM task_queue
      WHERE idempotency_key = ${'alert-enrich:edgar:' + ACCESSION}
    `;
    // Exactly one ALERT_ENRICH task — the duplicate call must not have added another
    expect(taskRows).toHaveLength(1);
  });
});

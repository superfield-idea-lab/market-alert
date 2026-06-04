/**
 * @file tests/integration/catalyst-dedup-silent-passage.spec.ts
 *
 * Integration tests for cross-venue dedup, catalyst state machine, and
 * silent-passage detection — Phase 6 (issue #81).
 *
 * ## What this tests
 *
 *   AC-1  The same event from wire lead and later filing collapses to one market_event
 *   AC-2  An anticipated window closing with no disclosure emits a PassedSilently event
 *   AC-3  State-machine transition guards enforce the PRD §6 lifecycle
 *
 * ## Coverage
 *
 *   - Integration test: wire + filing collapse to one event (AC-1)
 *   - Integration test: silent-passage emission on window close (AC-2)
 *   - Unit test: state-machine transition guards (AC-3)
 *   - Unit test: SILENT_PASSAGE_CHECK task type exists and maps correctly
 *   - Unit test: buildSilentPassageCheckIdempotencyKey formats correctly
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container. Zero vi.fn, vi.mock, vi.spyOn.
 *
 * ## Blueprint refs
 *
 * - TEST-D-001: golden-fixture-recording
 * - WORKER-T-002: no privileged DB access from worker process
 * - DATA-D-006: four-pool Postgres
 *
 * ## Canonical docs
 *
 * - docs/prd.md §6 — catalyst state machine lifecycle
 * - docs/prd.md §9 — cross-venue dedup, silent-passage latency ≤ 15 min
 * - docs/architecture.md § "Market-event feed" (cross-venue dedup)
 * - docs/architecture.md § task-type table (SILENT_PASSAGE_CHECK row)
 * - packages/db/mkt-market-event-store.ts — all functions tested here
 * - packages/db/task-queue.ts — SILENT_PASSAGE_CHECK task type
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/81
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { runInitRemote } from '../../packages/db/init-remote';
import { migrate, migrateMkt } from '../../packages/db/index';
import {
  insertRawFiling,
  insertMarketEvent,
  markFilingNormalized,
  dedupMarketEventByCompositeIdentity,
  isValidMarketEventTransition,
  transitionMarketEventStatus,
  transitionToPassedSilently,
  listExpectedEventsWithExpiredWindows,
  getMarketEventById,
  VALID_MARKET_EVENT_TRANSITIONS,
  DEFAULT_DEDUP_WINDOW_SECONDS,
  type MarketEventStatus,
} from '../../packages/db/mkt-market-event-store';
import {
  TaskType,
  TASK_TYPE_AGENT_MAP,
  buildSilentPassageCheckIdempotencyKey,
} from '../../packages/db/task-queue';

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

// Simulated encrypted payload (sentinel ciphertext — real encrypt/decrypt not needed)
const MOCK_CIPHERTEXT = 'enc:v1:dGVzdC1jaXBoZXJ0ZXh0';

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

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

  // 2. Provision roles and databases
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

  // 4. Apply base schema then mkt-schema
  await migrate({ databaseUrl: appRwUrl });
  await migrateMkt({ databaseUrl: appRwUrl });
}, 90_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Unit: SILENT_PASSAGE_CHECK task type
// ---------------------------------------------------------------------------

describe('SILENT_PASSAGE_CHECK task type', () => {
  test('TaskType.SILENT_PASSAGE_CHECK equals "SILENT_PASSAGE_CHECK"', () => {
    expect(TaskType.SILENT_PASSAGE_CHECK).toBe('SILENT_PASSAGE_CHECK');
  });

  test('TASK_TYPE_AGENT_MAP maps SILENT_PASSAGE_CHECK to event_evaluator', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.SILENT_PASSAGE_CHECK]).toBe('event_evaluator');
  });

  test('buildSilentPassageCheckIdempotencyKey formats key correctly', () => {
    const windowClose = new Date('2026-06-01T00:00:00.000Z');
    const key = buildSilentPassageCheckIdempotencyKey('event-abc-123', windowClose);
    expect(key).toBe('silent_check:event-abc-123:2026-06-01T00:00:00.000Z');
  });

  test('buildSilentPassageCheckIdempotencyKey is stable (same inputs → same key)', () => {
    const windowClose = new Date('2026-07-15T12:30:00.000Z');
    const key1 = buildSilentPassageCheckIdempotencyKey('ev-xyz', windowClose);
    const key2 = buildSilentPassageCheckIdempotencyKey('ev-xyz', windowClose);
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Unit: state-machine transition guards (AC-3)
// ---------------------------------------------------------------------------

describe('catalyst state-machine transition guards', () => {
  // Valid transitions per PRD §6 lifecycle
  const validTransitions: [MarketEventStatus, MarketEventStatus][] = [
    ['Expected', 'Detected'],
    ['Expected', 'PassedSilently'],
    ['Detected', 'Enriched'],
    ['Detected', 'Disputed'],
    ['Enriched', 'Evaluated'],
    ['Enriched', 'Disputed'],
    ['Evaluated', 'Closed'],
  ];

  // Invalid / illegal transitions
  const invalidTransitions: [MarketEventStatus, MarketEventStatus][] = [
    ['Expected', 'Enriched'], // must go through Detected first
    ['Expected', 'Evaluated'],
    ['Expected', 'Closed'],
    ['Expected', 'Disputed'], // Disputed only from Detected or Enriched
    ['Detected', 'Expected'], // no backwards transitions
    ['Detected', 'Evaluated'], // must go through Enriched
    ['Detected', 'Closed'],
    ['Enriched', 'Detected'], // no backwards
    ['Enriched', 'Expected'],
    ['Enriched', 'Closed'], // must go through Evaluated
    ['Evaluated', 'Detected'],
    ['Evaluated', 'Enriched'],
    ['Evaluated', 'Expected'],
    ['Closed', 'Evaluated'], // terminal — no exits
    ['Closed', 'Detected'],
    ['Disputed', 'Detected'], // terminal — no exits
    ['PassedSilently', 'Expected'], // terminal — no exits
    ['PassedSilently', 'Detected'],
  ];

  for (const [from, to] of validTransitions) {
    test(`isValidMarketEventTransition: ${from} → ${to} is permitted`, () => {
      expect(isValidMarketEventTransition(from, to)).toBe(true);
    });
  }

  for (const [from, to] of invalidTransitions) {
    test(`isValidMarketEventTransition: ${from} → ${to} is rejected`, () => {
      expect(isValidMarketEventTransition(from, to)).toBe(false);
    });
  }

  test('VALID_MARKET_EVENT_TRANSITIONS covers all seven status values', () => {
    const allStatuses: MarketEventStatus[] = [
      'Expected',
      'Detected',
      'Enriched',
      'Evaluated',
      'Closed',
      'Disputed',
      'PassedSilently',
    ];
    for (const s of allStatuses) {
      expect(VALID_MARKET_EVENT_TRANSITIONS.has(s)).toBe(true);
    }
  });

  test('terminal states (Closed, Disputed, PassedSilently) have no outbound transitions', () => {
    const terminals: MarketEventStatus[] = ['Closed', 'Disputed', 'PassedSilently'];
    for (const t of terminals) {
      expect(VALID_MARKET_EVENT_TRANSITIONS.get(t)?.size).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: dedupMarketEventByCompositeIdentity — no DB needed for these
// ---------------------------------------------------------------------------

describe('DEFAULT_DEDUP_WINDOW_SECONDS', () => {
  test('DEFAULT_DEDUP_WINDOW_SECONDS is 86400 (24 hours)', () => {
    expect(DEFAULT_DEDUP_WINDOW_SECONDS).toBe(86_400);
  });
});

// ---------------------------------------------------------------------------
// Schema: anticipated_window_close column exists (AC-2 prerequisite)
// ---------------------------------------------------------------------------

describe('market_events schema — anticipated_window_close column', () => {
  test('anticipated_window_close column exists after migrateMkt', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'market_events'
        AND column_name = 'anticipated_window_close'
    `;
    expect(rows).toHaveLength(1);
  });

  test('anticipated_window_close index exists for SILENT_PASSAGE_CHECK scans', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'market_events'
        AND indexname = 'idx_market_events_expected_window'
    `;
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: AC-1 — wire + filing collapse to one market_event
// ---------------------------------------------------------------------------

describe('cross-venue dedup: wire lead + later filing collapse to one market_event', () => {
  // Shared test state
  const WIRE_ACCESSION = '0000000001-26-000001';
  const FILING_ACCESSION = '0000000001-26-000002';
  const WIRE_IDEMPOTENCY_KEY = `edgar_poll:WIRE:${WIRE_ACCESSION}`;
  const FILING_IDEMPOTENCY_KEY = `edgar_poll:8-K:${FILING_ACCESSION}`;
  const SUBJECT_ENTITY = 'entity:cik:0001234567';
  const EVENT_TYPE = 'clinical_readout';
  const EVENT_DATE = new Date('2026-06-01T14:00:00Z');
  // Filing arrives 2h after the wire — within the 24h dedup window
  const FILING_EVENT_DATE = new Date('2026-06-01T16:00:00Z');

  let wireRawFilingId: string;
  let canonicalMarketEventId: string;
  let filingRawFilingId: string;

  test('AC-1a: wire lead creates a raw_filing and a Detected market_event', async () => {
    const rawFiling = await insertRawFiling({
      idempotency_key: WIRE_IDEMPOTENCY_KEY,
      source: 'wire',
      form_type: 'WIRE',
      accession_number: WIRE_ACCESSION,
      cik: '0001234567',
      issuer_name: 'ACME Biotech Inc',
      filing_date: EVENT_DATE,
      raw_payload_encrypted: MOCK_CIPHERTEXT,
      sql,
    });

    expect(rawFiling).not.toBeNull();
    expect(rawFiling!.source).toBe('wire');
    wireRawFilingId = rawFiling!.id;

    const marketEvent = await insertMarketEvent({
      raw_filing_id: wireRawFilingId,
      source: 'wire',
      event_type: EVENT_TYPE,
      subject_entity_id: SUBJECT_ENTITY,
      subject_entity_type: 'company',
      event_date: EVENT_DATE,
      description: 'ACME Biotech — Phase 3 trial readout (wire)',
      status: 'Detected',
      sql,
    });

    expect(marketEvent).not.toBeNull();
    expect(marketEvent!.status).toBe('Detected');
    expect(marketEvent!.subject_entity_id).toBe(SUBJECT_ENTITY);
    expect(marketEvent!.event_type).toBe(EVENT_TYPE);
    canonicalMarketEventId = marketEvent!.id;
  });

  test('AC-1b: later filing matches by composite identity — dedup returns the wire event', async () => {
    // The filing arrives 2h later. Dedup query must find the wire-lead event.
    const dedupResult = await dedupMarketEventByCompositeIdentity({
      subject_entity_id: SUBJECT_ENTITY,
      event_type: EVENT_TYPE,
      event_date: FILING_EVENT_DATE,
      dedup_window_seconds: DEFAULT_DEDUP_WINDOW_SECONDS,
      sql,
    });

    expect(dedupResult).not.toBeNull();
    // Must return the original wire-lead event, not a new one
    expect(dedupResult!.id).toBe(canonicalMarketEventId);
    expect(dedupResult!.source).toBe('wire');
  });

  test('AC-1c: filing raw_filing row is created and linked to the canonical event (no new market_event)', async () => {
    // Land the filing in raw_filings
    const filingRaw = await insertRawFiling({
      idempotency_key: FILING_IDEMPOTENCY_KEY,
      source: 'edgar',
      form_type: '8-K',
      accession_number: FILING_ACCESSION,
      cik: '0001234567',
      issuer_name: 'ACME Biotech Inc',
      filing_date: FILING_EVENT_DATE,
      raw_payload_encrypted: MOCK_CIPHERTEXT,
      sql,
    });

    expect(filingRaw).not.toBeNull();
    filingRawFilingId = filingRaw!.id;

    // Mark the filing as normalized without creating a new market_event
    // (the dedup resolved to the canonical event above)
    await markFilingNormalized(filingRawFilingId, sql);

    // Verify: raw_filings row is normalized
    const updatedFiling = await sql<{ status: string }[]>`
      SELECT status FROM raw_filings WHERE id = ${filingRawFilingId}
    `;
    expect(updatedFiling[0].status).toBe('normalized');

    // Verify: still only one market_event for this composite identity
    const eventCount = await sql<{ c: string }[]>`
      SELECT COUNT(*)::TEXT AS c FROM market_events
      WHERE subject_entity_id = ${SUBJECT_ENTITY}
        AND event_type = ${EVENT_TYPE}
    `;
    expect(eventCount[0].c).toBe('1');
  });

  test('AC-1d: dedupMarketEventByCompositeIdentity returns null when no matching event exists', async () => {
    const noMatch = await dedupMarketEventByCompositeIdentity({
      subject_entity_id: 'entity:cik:9999999999',
      event_type: 'merger_announcement',
      event_date: new Date('2026-01-01T00:00:00Z'),
      sql,
    });
    expect(noMatch).toBeNull();
  });

  test('AC-1e: dedupMarketEventByCompositeIdentity returns null when event is outside the dedup window', async () => {
    // 48h later — outside the 24h dedup window
    const farFuture = new Date(EVENT_DATE.getTime() + 48 * 60 * 60 * 1000);
    const noMatch = await dedupMarketEventByCompositeIdentity({
      subject_entity_id: SUBJECT_ENTITY,
      event_type: EVENT_TYPE,
      event_date: farFuture,
      dedup_window_seconds: DEFAULT_DEDUP_WINDOW_SECONDS,
      sql,
    });
    expect(noMatch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: AC-2 — silent-passage emission on window close
// ---------------------------------------------------------------------------

describe('silent-passage detection: Expected event transitions to PassedSilently on window close', () => {
  const SUBJECT_ENTITY = 'entity:cik:7777777777';
  const EVENT_TYPE = 'fda_approval_decision';
  // Anticipated window closes in the past (simulated)
  const WINDOW_CLOSE = new Date('2026-05-01T00:00:00Z');
  const ANTICIPATED_EVENT_DATE = new Date('2026-04-30T09:00:00Z');
  const ACCESSION = '0007777777-26-000001';
  const IDEMPOTENCY_KEY = `edgar_poll:EXPECTED:${ACCESSION}`;

  let expectedRawFilingId: string;
  let expectedMarketEventId: string;

  test('AC-2a: register an Expected event with anticipated_window_close', async () => {
    const rawFiling = await insertRawFiling({
      idempotency_key: IDEMPOTENCY_KEY,
      source: 'methodology',
      form_type: 'EXPECTED',
      accession_number: ACCESSION,
      cik: '7777777777',
      issuer_name: 'Biotech Target Corp',
      filing_date: ANTICIPATED_EVENT_DATE,
      raw_payload_encrypted: MOCK_CIPHERTEXT,
      sql,
    });
    expect(rawFiling).not.toBeNull();
    expectedRawFilingId = rawFiling!.id;

    const marketEvent = await insertMarketEvent({
      raw_filing_id: expectedRawFilingId,
      source: 'methodology',
      event_type: EVENT_TYPE,
      subject_entity_id: SUBJECT_ENTITY,
      subject_entity_type: 'company',
      event_date: ANTICIPATED_EVENT_DATE,
      anticipated_window_close: WINDOW_CLOSE,
      description: 'FDA approval decision — anticipated Q2 2026',
      status: 'Expected',
      sql,
    });

    expect(marketEvent).not.toBeNull();
    expect(marketEvent!.status).toBe('Expected');
    expectedMarketEventId = marketEvent!.id;
  });

  test('AC-2b: listExpectedEventsWithExpiredWindows returns the event after window close', async () => {
    // Use a time after the window close to simulate SILENT_PASSAGE_CHECK running
    const afterWindowClose = new Date(WINDOW_CLOSE.getTime() + 60_000); // 1 min after close
    const expired = await listExpectedEventsWithExpiredWindows(sql, afterWindowClose);

    const found = expired.find((e) => e.id === expectedMarketEventId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('Expected');
    expect(found!.subject_entity_id).toBe(SUBJECT_ENTITY);
  });

  test('AC-2c: listExpectedEventsWithExpiredWindows does NOT return the event before window close', async () => {
    // 1 minute before the window close — event should NOT be in the list
    const beforeWindowClose = new Date(WINDOW_CLOSE.getTime() - 60_000);
    const notExpiredYet = await listExpectedEventsWithExpiredWindows(sql, beforeWindowClose);

    const found = notExpiredYet.find((e) => e.id === expectedMarketEventId);
    expect(found).toBeUndefined();
  });

  test('AC-2d: transitionToPassedSilently transitions Expected → PassedSilently', async () => {
    const updated = await transitionToPassedSilently(expectedMarketEventId, sql);

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(expectedMarketEventId);
    expect(updated!.status).toBe('PassedSilently');
  });

  test('AC-2e: after transition, event no longer appears in listExpectedEventsWithExpiredWindows', async () => {
    const afterWindowClose = new Date(WINDOW_CLOSE.getTime() + 60_000);
    const expired = await listExpectedEventsWithExpiredWindows(sql, afterWindowClose);

    const found = expired.find((e) => e.id === expectedMarketEventId);
    expect(found).toBeUndefined();
  });

  test('AC-2f: SILENT_PASSAGE_CHECK idempotency key can be enqueued in task_queue', async () => {
    const ikey = buildSilentPassageCheckIdempotencyKey(expectedMarketEventId, WINDOW_CLOSE);
    const payloadObj = {
      expected_event_id: expectedMarketEventId,
      window_close: WINDOW_CLOSE.toISOString(),
    };

    await sql`
      INSERT INTO task_queue
        (idempotency_key, agent_type, job_type, payload, created_by, priority)
      VALUES (
        ${ikey},
        ${TASK_TYPE_AGENT_MAP[TaskType.SILENT_PASSAGE_CHECK]},
        ${TaskType.SILENT_PASSAGE_CHECK},
        ${sql.json(payloadObj)},
        'test-runner',
        3
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;

    const taskRows = await sql<{ id: string; job_type: string }[]>`
      SELECT id, job_type FROM task_queue WHERE idempotency_key = ${ikey}
    `;
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].job_type).toBe('SILENT_PASSAGE_CHECK');
  });
});

// ---------------------------------------------------------------------------
// Integration: AC-3 — state-machine transitions enforced at DB layer
// ---------------------------------------------------------------------------

describe('state machine transitions: DB layer enforcement', () => {
  const SUBJECT_ENTITY = 'entity:cik:5555555555';
  const ACCESSION = '0005555555-26-000001';
  const IDEMPOTENCY_KEY = `edgar_poll:8-K:${ACCESSION}`;

  let marketEventId: string;
  let rawFilingId: string;

  test('setup: create a Detected market_event for state-machine tests', async () => {
    const rawFiling = await insertRawFiling({
      idempotency_key: IDEMPOTENCY_KEY,
      source: 'edgar',
      form_type: '8-K',
      accession_number: ACCESSION,
      cik: '5555555555',
      issuer_name: 'State Machine Corp',
      filing_date: new Date('2026-06-03T10:00:00Z'),
      raw_payload_encrypted: MOCK_CIPHERTEXT,
      sql,
    });
    expect(rawFiling).not.toBeNull();
    rawFilingId = rawFiling!.id;

    const marketEvent = await insertMarketEvent({
      raw_filing_id: rawFilingId,
      source: 'edgar',
      event_type: '8-K',
      subject_entity_id: SUBJECT_ENTITY,
      subject_entity_type: 'company',
      event_date: new Date('2026-06-03T10:00:00Z'),
      status: 'Detected',
      sql,
    });
    expect(marketEvent).not.toBeNull();
    marketEventId = marketEvent!.id;
  });

  test('AC-3a: valid transition Detected → Enriched succeeds', async () => {
    const row = await transitionMarketEventStatus(marketEventId, 'Detected', 'Enriched', sql);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('Enriched');
  });

  test('AC-3b: valid transition Enriched → Evaluated succeeds', async () => {
    const row = await transitionMarketEventStatus(marketEventId, 'Enriched', 'Evaluated', sql);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('Evaluated');
  });

  test('AC-3c: valid transition Evaluated → Closed succeeds', async () => {
    const row = await transitionMarketEventStatus(marketEventId, 'Evaluated', 'Closed', sql);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('Closed');
  });

  test('AC-3d: invalid transition from terminal Closed throws an error', async () => {
    await expect(
      transitionMarketEventStatus(marketEventId, 'Closed', 'Evaluated', sql),
    ).rejects.toThrow('Invalid state machine transition');
  });

  test('AC-3e: invalid transition (skipping steps) throws an error', async () => {
    // Create a fresh Detected event for this test
    const accession2 = '0005555555-26-000002';
    const raw2 = await insertRawFiling({
      idempotency_key: `edgar_poll:8-K:${accession2}`,
      source: 'edgar',
      form_type: '8-K',
      accession_number: accession2,
      cik: '5555555555',
      issuer_name: 'State Machine Corp',
      filing_date: new Date('2026-06-03T11:00:00Z'),
      raw_payload_encrypted: MOCK_CIPHERTEXT,
      sql,
    });
    expect(raw2).not.toBeNull();

    const me2 = await insertMarketEvent({
      raw_filing_id: raw2!.id,
      source: 'edgar',
      event_type: '8-K',
      subject_entity_id: 'entity:cik:5555555556',
      subject_entity_type: 'company',
      event_date: new Date('2026-06-03T11:00:00Z'),
      status: 'Detected',
      sql,
    });
    expect(me2).not.toBeNull();

    // Skip Enriched — jump straight from Detected to Evaluated
    await expect(
      transitionMarketEventStatus(me2!.id, 'Detected', 'Evaluated', sql),
    ).rejects.toThrow('Invalid state machine transition');
  });

  test('AC-3f: transitionMarketEventStatus returns null when current status does not match (concurrent update)', async () => {
    // Create a fresh event in Detected state
    const accession3 = '0005555555-26-000003';
    const raw3 = await insertRawFiling({
      idempotency_key: `edgar_poll:8-K:${accession3}`,
      source: 'edgar',
      form_type: '8-K',
      accession_number: accession3,
      cik: '5555555555',
      filing_date: new Date('2026-06-03T12:00:00Z'),
      raw_payload_encrypted: MOCK_CIPHERTEXT,
      sql,
    });
    const me3 = await insertMarketEvent({
      raw_filing_id: raw3!.id,
      source: 'edgar',
      event_type: '8-K',
      subject_entity_id: 'entity:cik:5555555557',
      event_date: new Date('2026-06-03T12:00:00Z'),
      status: 'Detected',
      sql,
    });
    expect(me3).not.toBeNull();

    // Simulate a concurrent update that already advanced to Enriched
    await sql`UPDATE market_events SET status = 'Enriched' WHERE id = ${me3!.id}`;

    // Now try to transition from Detected → Enriched (but it's already Enriched)
    // The WHERE status = 'Detected' clause matches nothing → returns null
    const result = await transitionMarketEventStatus(me3!.id, 'Detected', 'Enriched', sql);
    expect(result).toBeNull();
  });

  test('AC-3g: getMarketEventById retrieves the correct row', async () => {
    // Create a fresh event
    const accession4 = '0005555555-26-000004';
    const raw4 = await insertRawFiling({
      idempotency_key: `edgar_poll:8-K:${accession4}`,
      source: 'edgar',
      form_type: '8-K',
      accession_number: accession4,
      cik: '5555555555',
      filing_date: new Date('2026-06-03T13:00:00Z'),
      raw_payload_encrypted: MOCK_CIPHERTEXT,
      sql,
    });
    const me4 = await insertMarketEvent({
      raw_filing_id: raw4!.id,
      source: 'edgar',
      event_type: '8-K',
      subject_entity_id: 'entity:cik:5555555558',
      event_date: new Date('2026-06-03T13:00:00Z'),
      status: 'Detected',
      sql,
    });
    expect(me4).not.toBeNull();

    const fetched = await getMarketEventById(me4!.id, sql);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(me4!.id);
    expect(fetched!.status).toBe('Detected');
    expect(fetched!.event_type).toBe('8-K');
  });
});

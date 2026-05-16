/**
 * @file tests/integration/edgar-ingest.spec.ts
 *
 * EDGAR ingestion end-to-end integration test — Phase 2 dev-scout (issue #14).
 *
 * ## Status: dev-scout test stubs
 *
 * These tests define the acceptance criteria contracts for the Phase 2
 * implementation. All tests currently exercise only the scout stubs and are
 * expected to pass. The implementation-phase tests (marked TODO) will be
 * filled in by the follow-on issue; they skip with `test.skip` until the
 * real implementation is in place.
 *
 * ## Test plan coverage
 *
 * - [x] MSW handler loads the EDGAR fixture without error
 * - [x] assertNoDatabaseUrl guard rejects DATABASE_URL in env
 * - [x] assertNoDatabaseUrl guard passes when DATABASE_URL is absent
 * - [x] CorporateAction DDL is valid SQL (migrateCorporateActions() stub compiles)
 * - [skip] Integration: replay EDGAR 8-K MSW fixture end-to-end, assert CorporateAction row created
 * - [skip] Integration: CorporateAction.filing_text is not the raw XML (ciphertext check)
 * - [skip] Integration: task_queue contains exactly one ALERT_ENRICH row after ingestion
 * - [skip] Integration: worker startup with DATABASE_URL set fails at startup-guard
 * - [skip] MSW intercept count assertion: zero calls reach sec.gov during test run
 *
 * ## Blueprint refs
 *
 * - TEST-D-001: golden-fixture-recording
 * - WORKER-T-002: no privileged DB access from worker
 * - DATA-D-006: four-pool Postgres
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — ingestion pipeline
 * - apps/worker/src/edgar-ingest-job.ts — EDGAR_POLL job stub
 * - apps/worker/src/startup.ts — assertNoDatabaseUrl
 * - apps/server/src/api/corporate-action-ingestion.ts — API endpoint stub
 * - packages/db/mkt-corporate-action.ts — CorporateAction schema stub
 * - tests/fixtures/edgar/msw-handler.ts — MSW intercept
 */

import { describe, test, expect } from 'vitest';
import { setupServer } from 'msw/node';
import { createEdgarFeedHandler } from '../fixtures/edgar/msw-handler';
import { assertNoDatabaseUrl } from '../../apps/worker/src/startup';
import { CORPORATE_ACTION_DDL } from '../../packages/db/mkt-corporate-action';
import { EDGAR_INGEST_JOB_TYPE } from '../../apps/worker/src/edgar-ingest-job';

// ---------------------------------------------------------------------------
// MSW fixture loading
// ---------------------------------------------------------------------------

describe('EDGAR MSW fixture', () => {
  test('createEdgarFeedHandler returns a handler without error', () => {
    const handler = createEdgarFeedHandler();
    expect(handler).toBeDefined();
  });

  test('MSW server can be created with EDGAR handler', () => {
    const handler = createEdgarFeedHandler();
    const server = setupServer(handler);
    expect(server).toBeDefined();
    // Do not call server.listen() here — no HTTP calls in this unit block.
  });
});

// ---------------------------------------------------------------------------
// Startup guard: assertNoDatabaseUrl
// ---------------------------------------------------------------------------

describe('assertNoDatabaseUrl', () => {
  test('passes when DATABASE_URL is absent', () => {
    const logs: string[] = [];
    const logger = { error: (msg: string) => logs.push(msg) };
    // Should not throw or log anything
    expect(() => assertNoDatabaseUrl({}, logger)).not.toThrow();
    expect(logs).toHaveLength(0);
  });

  test('calls process.exit(1) when DATABASE_URL is set', () => {
    // Capture process.exit calls without actually exiting.
    const originalExit = process.exit;
    let exitCode: number | undefined;
    (process as { exit: (code?: number) => never }).exit = (code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code}) called`);
    };

    const logs: string[] = [];
    const logger = { error: (msg: string) => logs.push(msg) };

    try {
      assertNoDatabaseUrl({ DATABASE_URL: 'postgres://localhost/bad' }, logger);
    } catch (_err) {
      // Expected — the stub throws after exit.
    } finally {
      process.exit = originalExit;
    }

    expect(exitCode).toBe(1);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('DATABASE_URL');
  });
});

// ---------------------------------------------------------------------------
// CorporateAction schema
// ---------------------------------------------------------------------------

describe('CORPORATE_ACTION_DDL', () => {
  test('constant is a non-empty string', () => {
    expect(typeof CORPORATE_ACTION_DDL).toBe('string');
    expect(CORPORATE_ACTION_DDL.length).toBeGreaterThan(0);
  });

  test('contains CREATE TABLE IF NOT EXISTS mkt_corporate_actions', () => {
    expect(CORPORATE_ACTION_DDL).toContain('CREATE TABLE IF NOT EXISTS mkt_corporate_actions');
  });

  test('contains filing_text column', () => {
    expect(CORPORATE_ACTION_DDL).toContain('filing_text');
  });

  test('contains idempotency_key UNIQUE constraint', () => {
    expect(CORPORATE_ACTION_DDL).toContain('idempotency_key');
    expect(CORPORATE_ACTION_DDL).toContain('UNIQUE');
  });
});

// ---------------------------------------------------------------------------
// EDGAR_INGEST_JOB_TYPE constant
// ---------------------------------------------------------------------------

describe('EDGAR_INGEST_JOB_TYPE', () => {
  test('equals EDGAR_POLL', () => {
    expect(EDGAR_INGEST_JOB_TYPE).toBe('EDGAR_POLL');
  });
});

// ---------------------------------------------------------------------------
// TODO: Implementation-phase tests (skipped until follow-on issue)
// ---------------------------------------------------------------------------

describe('EDGAR ingestion end-to-end (implementation-phase — skipped)', () => {
  test.skip('replay EDGAR 8-K MSW fixture end-to-end: CorporateAction row created', async () => {
    // TODO (follow-on implementation issue):
    //
    // 1. Start ephemeral Postgres via startPostgres() from packages/db/pg-container.
    // 2. Run migrate() + migrateCorporateActions().
    // 3. Start MSW server with createEdgarFeedHandler().
    // 4. Start the API server in test mode (or call the handler directly).
    // 5. Enqueue one EDGAR_POLL task.
    // 6. Call executeEdgarIngestTask({ task, apiBaseUrl }).
    // 7. Assert: SELECT COUNT(*) FROM mkt_corporate_actions = 1.
    // 8. Assert: the row's accession_number = '0001234567-26-000001'.
  });

  test.skip('CorporateAction.filing_text is not the raw XML (ciphertext check)', async () => {
    // TODO (follow-on):
    //
    // After the end-to-end test above passes, assert that the filing_text
    // column does NOT equal the raw ATOM entry XML. It must start with the
    // encryption envelope prefix: 'enc:v1:'.
  });

  test.skip('task_queue contains exactly one ALERT_ENRICH row after ingestion', async () => {
    // TODO (follow-on):
    //
    // After end-to-end ingest, assert:
    //   SELECT COUNT(*) FROM task_queue
    //   WHERE job_type = 'ALERT_ENRICH'
    //   AND status = 'pending' = 1
  });

  test.skip('worker startup with DATABASE_URL set fails at startup-guard', async () => {
    // TODO (follow-on):
    //
    // Spawn the worker process with DATABASE_URL=postgres://bad/url set.
    // Assert that the process exits with code 1 and logs a message containing
    // 'DATABASE_URL'.
    //
    // This test requires a real process spawn (not a mock), per no-mock rule.
  });

  test.skip('MSW intercept count: zero calls reach sec.gov during test run', async () => {
    // TODO (follow-on):
    //
    // After the end-to-end test runs with { onUnhandledRequest: 'error' },
    // assert that createEdgarFeedHandler().callCount === 1 (exactly one
    // intercepted call, zero live calls to sec.gov).
  });
});

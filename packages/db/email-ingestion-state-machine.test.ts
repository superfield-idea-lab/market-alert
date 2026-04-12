/**
 * Integration tests for the email ingestion state machine (issue #32).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * Test plan coverage:
 *   - Drive an email through every legal forward transition and assert success.
 *   - Attempt an illegal transition and assert rejection with IllegalTransitionError.
 *   - Force a failure state and assert recovery transitions succeed.
 *   - Assert every transition carries a timestamp and correct from/to_state values.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import {
  EmailIngestionState,
  LEGAL_TRANSITIONS,
  IllegalTransitionError,
  initEmailState,
  getEmailState,
  transition,
  getTransitionHistory,
  migrateEmailIngestionSchema,
} from './email-ingestion-state-machine';

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });
  // Apply the state-machine DDL to the fresh container
  await migrateEmailIngestionSchema(sql);
}, 60_000);

afterAll(async () => {
  await sql.end();
  await pg.stop();
});

// ---------------------------------------------------------------------------
// Helper — generate unique email IDs so tests do not collide
// ---------------------------------------------------------------------------

let counter = 0;
function emailId(): string {
  return `email-test-${Date.now()}-${++counter}`;
}

// ---------------------------------------------------------------------------
// State enum completeness
// ---------------------------------------------------------------------------

describe('EmailIngestionState enum', () => {
  test('contains all PRD §4.1 states', () => {
    expect(Object.keys(EmailIngestionState).sort()).toEqual(
      ['ANONYMISING', 'FAILED', 'IMAP_RECEIVED', 'INDEXED', 'QUEUED', 'STORING'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// LEGAL_TRANSITIONS map
// ---------------------------------------------------------------------------

describe('LEGAL_TRANSITIONS', () => {
  test('every state has an entry', () => {
    for (const state of Object.values(EmailIngestionState)) {
      expect(LEGAL_TRANSITIONS[state]).toBeDefined();
    }
  });

  test('IMAP_RECEIVED → ANONYMISING only', () => {
    expect(LEGAL_TRANSITIONS[EmailIngestionState.IMAP_RECEIVED]).toEqual([
      EmailIngestionState.ANONYMISING,
    ]);
  });

  test('ANONYMISING can go to STORING or FAILED', () => {
    expect(LEGAL_TRANSITIONS[EmailIngestionState.ANONYMISING]).toContain(
      EmailIngestionState.STORING,
    );
    expect(LEGAL_TRANSITIONS[EmailIngestionState.ANONYMISING]).toContain(
      EmailIngestionState.FAILED,
    );
  });

  test('STORING can go to QUEUED or FAILED', () => {
    expect(LEGAL_TRANSITIONS[EmailIngestionState.STORING]).toContain(EmailIngestionState.QUEUED);
    expect(LEGAL_TRANSITIONS[EmailIngestionState.STORING]).toContain(EmailIngestionState.FAILED);
  });

  test('QUEUED → INDEXED only', () => {
    expect(LEGAL_TRANSITIONS[EmailIngestionState.QUEUED]).toEqual([EmailIngestionState.INDEXED]);
  });

  test('INDEXED has no outgoing transitions (terminal state)', () => {
    expect(LEGAL_TRANSITIONS[EmailIngestionState.INDEXED]).toEqual([]);
  });

  test('FAILED → ANONYMISING and FAILED → STORING (recovery paths)', () => {
    expect(LEGAL_TRANSITIONS[EmailIngestionState.FAILED]).toContain(
      EmailIngestionState.ANONYMISING,
    );
    expect(LEGAL_TRANSITIONS[EmailIngestionState.FAILED]).toContain(EmailIngestionState.STORING);
  });
});

// ---------------------------------------------------------------------------
// initEmailState
// ---------------------------------------------------------------------------

describe('initEmailState', () => {
  test('creates state row with IMAP_RECEIVED', async () => {
    const id = emailId();
    const result = await initEmailState(sql, id);
    expect(result.newState).toBe(EmailIngestionState.IMAP_RECEIVED);
    expect(result.transitionRow.email_id).toBe(id);
    expect(result.transitionRow.from_state).toBeNull();
    expect(result.transitionRow.to_state).toBe(EmailIngestionState.IMAP_RECEIVED);
    expect(result.transitionRow.transitioned_at).toBeInstanceOf(Date);
  });

  test('records a reason when provided', async () => {
    const id = emailId();
    const result = await initEmailState(sql, id, 'IMAP poll at 2026-04-11T00:00:00Z');
    expect(result.transitionRow.reason).toBe('IMAP poll at 2026-04-11T00:00:00Z');
  });

  test('getEmailState returns IMAP_RECEIVED after init', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    const state = await getEmailState(sql, id);
    expect(state).toBe(EmailIngestionState.IMAP_RECEIVED);
  });

  test('getEmailState returns null for unknown email', async () => {
    const state = await getEmailState(sql, 'nonexistent-email-id');
    expect(state).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full forward path: every legal forward transition
// ---------------------------------------------------------------------------

describe('complete forward path', () => {
  test('drives an email through all forward states to INDEXED', async () => {
    const id = emailId();

    await initEmailState(sql, id, 'IMAP received');

    const r1 = await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    expect(r1.newState).toBe(EmailIngestionState.ANONYMISING);
    expect(r1.transitionRow.from_state).toBe(EmailIngestionState.IMAP_RECEIVED);
    expect(r1.transitionRow.transitioned_at).toBeInstanceOf(Date);

    const r2 = await transition(sql, { emailId: id, toState: EmailIngestionState.STORING });
    expect(r2.newState).toBe(EmailIngestionState.STORING);
    expect(r2.transitionRow.from_state).toBe(EmailIngestionState.ANONYMISING);
    expect(r2.transitionRow.transitioned_at).toBeInstanceOf(Date);

    const r3 = await transition(sql, { emailId: id, toState: EmailIngestionState.QUEUED });
    expect(r3.newState).toBe(EmailIngestionState.QUEUED);
    expect(r3.transitionRow.from_state).toBe(EmailIngestionState.STORING);
    expect(r3.transitionRow.transitioned_at).toBeInstanceOf(Date);

    const r4 = await transition(sql, { emailId: id, toState: EmailIngestionState.INDEXED });
    expect(r4.newState).toBe(EmailIngestionState.INDEXED);
    expect(r4.transitionRow.from_state).toBe(EmailIngestionState.QUEUED);
    expect(r4.transitionRow.transitioned_at).toBeInstanceOf(Date);

    // Verify final DB state
    const finalState = await getEmailState(sql, id);
    expect(finalState).toBe(EmailIngestionState.INDEXED);
  });

  test('each transition row carries a non-null transitioned_at timestamp', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });

    const history = await getTransitionHistory(sql, id);
    for (const row of history) {
      expect(row.transitioned_at).toBeInstanceOf(Date);
      expect(Number.isFinite(row.transitioned_at.getTime())).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// getTransitionHistory
// ---------------------------------------------------------------------------

describe('getTransitionHistory', () => {
  test('returns ordered transition log matching the path taken', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    await transition(sql, { emailId: id, toState: EmailIngestionState.STORING });
    await transition(sql, { emailId: id, toState: EmailIngestionState.QUEUED });
    await transition(sql, { emailId: id, toState: EmailIngestionState.INDEXED });

    const history = await getTransitionHistory(sql, id);
    expect(history).toHaveLength(5);

    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      EmailIngestionState.IMAP_RECEIVED,
      EmailIngestionState.ANONYMISING,
      EmailIngestionState.STORING,
      EmailIngestionState.QUEUED,
      EmailIngestionState.INDEXED,
    ]);
  });

  test('from_state is null only for the init record', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });

    const history = await getTransitionHistory(sql, id);
    expect(history[0].from_state).toBeNull();
    expect(history[1].from_state).toBe(EmailIngestionState.IMAP_RECEIVED);
  });
});

// ---------------------------------------------------------------------------
// Illegal transition rejection
// ---------------------------------------------------------------------------

describe('illegal transitions are rejected', () => {
  test('IMAP_RECEIVED → STORING is illegal', async () => {
    const id = emailId();
    await initEmailState(sql, id);

    await expect(
      transition(sql, { emailId: id, toState: EmailIngestionState.STORING }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  test('IMAP_RECEIVED → QUEUED is illegal', async () => {
    const id = emailId();
    await initEmailState(sql, id);

    await expect(
      transition(sql, { emailId: id, toState: EmailIngestionState.QUEUED }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  test('IMAP_RECEIVED → INDEXED is illegal', async () => {
    const id = emailId();
    await initEmailState(sql, id);

    await expect(
      transition(sql, { emailId: id, toState: EmailIngestionState.INDEXED }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  test('INDEXED → QUEUED is illegal (no backward transitions from terminal state)', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    await transition(sql, { emailId: id, toState: EmailIngestionState.STORING });
    await transition(sql, { emailId: id, toState: EmailIngestionState.QUEUED });
    await transition(sql, { emailId: id, toState: EmailIngestionState.INDEXED });

    await expect(
      transition(sql, { emailId: id, toState: EmailIngestionState.QUEUED }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  test('IllegalTransitionError includes from/to state in message', async () => {
    const id = emailId();
    await initEmailState(sql, id);

    let caught: unknown;
    try {
      await transition(sql, { emailId: id, toState: EmailIngestionState.STORING });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IllegalTransitionError);
    const err = caught as IllegalTransitionError;
    expect(err.from).toBe(EmailIngestionState.IMAP_RECEIVED);
    expect(err.to).toBe(EmailIngestionState.STORING);
    expect(err.message).toContain('IMAP_RECEIVED');
    expect(err.message).toContain('STORING');
  });

  test('state is unchanged after a rejected transition', async () => {
    const id = emailId();
    await initEmailState(sql, id);

    await expect(
      transition(sql, { emailId: id, toState: EmailIngestionState.INDEXED }),
    ).rejects.toThrow(IllegalTransitionError);

    // State must still be IMAP_RECEIVED
    const state = await getEmailState(sql, id);
    expect(state).toBe(EmailIngestionState.IMAP_RECEIVED);
  });

  test('transition() throws for unknown email_id', async () => {
    await expect(
      transition(sql, {
        emailId: 'does-not-exist',
        toState: EmailIngestionState.ANONYMISING,
      }),
    ).rejects.toThrow(/No ingestion state found/);
  });
});

// ---------------------------------------------------------------------------
// Failure state and recovery
// ---------------------------------------------------------------------------

describe('failure state and recovery', () => {
  test('ANONYMISING → FAILED records failure reason', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });

    const r = await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.FAILED,
      reason: 'PII tokeniser timeout after 30s',
    });

    expect(r.newState).toBe(EmailIngestionState.FAILED);
    expect(r.transitionRow.reason).toBe('PII tokeniser timeout after 30s');
    expect(r.transitionRow.from_state).toBe(EmailIngestionState.ANONYMISING);
    expect(r.transitionRow.transitioned_at).toBeInstanceOf(Date);
  });

  test('STORING → FAILED is legal', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    await transition(sql, { emailId: id, toState: EmailIngestionState.STORING });

    const r = await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.FAILED,
      reason: 'DB write error on attempt 3',
    });

    expect(r.newState).toBe(EmailIngestionState.FAILED);
    expect(r.transitionRow.reason).toBe('DB write error on attempt 3');
  });

  test('FAILED → ANONYMISING (recovery from anonymisation failure)', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.FAILED,
      reason: 'anonymiser crash',
    });

    const r = await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.ANONYMISING,
      reason: 'retry attempt 2',
    });

    expect(r.newState).toBe(EmailIngestionState.ANONYMISING);
    expect(r.transitionRow.from_state).toBe(EmailIngestionState.FAILED);
    expect(r.transitionRow.reason).toBe('retry attempt 2');
  });

  test('FAILED → STORING (recovery when anonymisation already succeeded)', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    await transition(sql, { emailId: id, toState: EmailIngestionState.STORING });
    await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.FAILED,
      reason: 'DB timeout',
    });

    const r = await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.STORING,
      reason: 'retry DB write',
    });

    expect(r.newState).toBe(EmailIngestionState.STORING);
    expect(r.transitionRow.from_state).toBe(EmailIngestionState.FAILED);
  });

  test('full recovery path: fail during ANONYMISING then complete to INDEXED', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.FAILED,
      reason: 'first attempt failed',
    });

    // Retry from ANONYMISING
    await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.ANONYMISING,
      reason: 'retry',
    });
    await transition(sql, { emailId: id, toState: EmailIngestionState.STORING });
    await transition(sql, { emailId: id, toState: EmailIngestionState.QUEUED });
    await transition(sql, { emailId: id, toState: EmailIngestionState.INDEXED });

    const finalState = await getEmailState(sql, id);
    expect(finalState).toBe(EmailIngestionState.INDEXED);

    const history = await getTransitionHistory(sql, id);
    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      EmailIngestionState.IMAP_RECEIVED,
      EmailIngestionState.ANONYMISING,
      EmailIngestionState.FAILED,
      EmailIngestionState.ANONYMISING,
      EmailIngestionState.STORING,
      EmailIngestionState.QUEUED,
      EmailIngestionState.INDEXED,
    ]);
  });

  test('FAILED → INDEXED is illegal (must go through recovery path)', async () => {
    const id = emailId();
    await initEmailState(sql, id);
    await transition(sql, { emailId: id, toState: EmailIngestionState.ANONYMISING });
    await transition(sql, {
      emailId: id,
      toState: EmailIngestionState.FAILED,
      reason: 'error',
    });

    await expect(
      transition(sql, { emailId: id, toState: EmailIngestionState.INDEXED }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

/**
 * Unit tests for email-ingest-job.ts stubs.
 *
 * Phase 2 dev-scout (issue #25). These tests verify that:
 *   - The job-type constant is correct.
 *   - The payload builder produces the expected shape.
 *   - The result validator accepts valid results and rejects invalid ones.
 *
 * No mocks. No vi.fn / vi.mock / vi.spyOn. All assertions are against
 * pure synchronous functions — no I/O or subprocess calls are made.
 */

import { describe, test, expect } from 'vitest';
import {
  EMAIL_INGEST_JOB_TYPE,
  EMAIL_INGEST_TIMEOUT_MS,
  buildEmailIngestPayload,
  validateEmailIngestResult,
} from '../../src/email-ingest-job';

// ---------------------------------------------------------------------------
// Job-type constant
// ---------------------------------------------------------------------------

describe('EMAIL_INGEST_JOB_TYPE', () => {
  test('is the string "email_ingest"', () => {
    expect(EMAIL_INGEST_JOB_TYPE).toBe('email_ingest');
  });
});

// ---------------------------------------------------------------------------
// Timeout constant
// ---------------------------------------------------------------------------

describe('EMAIL_INGEST_TIMEOUT_MS', () => {
  test('is a positive number (5 minutes)', () => {
    expect(typeof EMAIL_INGEST_TIMEOUT_MS).toBe('number');
    expect(EMAIL_INGEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(EMAIL_INGEST_TIMEOUT_MS).toBe(5 * 60 * 1_000);
  });
});

// ---------------------------------------------------------------------------
// buildEmailIngestPayload
// ---------------------------------------------------------------------------

describe('buildEmailIngestPayload', () => {
  test('includes task id, job_type, and agent_type', () => {
    const payload = buildEmailIngestPayload('task-001', 'email_ingest', {
      mailbox_ref: 'mbox-abc',
      uid: '42',
      tenant_ref: 'tenant-xyz',
      ingest_ref: 'mbox-abc-42',
    });

    expect(payload.id).toBe('task-001');
    expect(payload.job_type).toBe(EMAIL_INGEST_JOB_TYPE);
    expect(payload.agent_type).toBe('email_ingest');
  });

  test('merges all payload fields into the returned object', () => {
    const raw = {
      mailbox_ref: 'mbox-001',
      uid: '99',
      tenant_ref: 'tenant-001',
      ingest_ref: 'mbox-001-99',
    };
    const result = buildEmailIngestPayload('task-002', 'email_ingest', raw);

    expect(result.mailbox_ref).toBe('mbox-001');
    expect(result.uid).toBe('99');
    expect(result.tenant_ref).toBe('tenant-001');
    expect(result.ingest_ref).toBe('mbox-001-99');
  });

  test('does not mutate the input payload object', () => {
    const raw = { mailbox_ref: 'mbox-x', uid: '1', tenant_ref: 't', ingest_ref: 'mbox-x-1' };
    const before = { ...raw };
    buildEmailIngestPayload('task-003', 'email_ingest', raw);
    expect(raw).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// validateEmailIngestResult
// ---------------------------------------------------------------------------

describe('validateEmailIngestResult', () => {
  const validResult = {
    email_id: 'email-ent-001',
    chunk_ids: ['chunk-001', 'chunk-002'],
    chunk_count: 2,
    ingest_ref: 'mbox-abc-42',
    status: 'completed' as const,
  };

  test('accepts a valid result object', () => {
    const out = validateEmailIngestResult(validResult);
    expect(out.email_id).toBe('email-ent-001');
    expect(out.chunk_ids).toEqual(['chunk-001', 'chunk-002']);
    expect(out.chunk_count).toBe(2);
    expect(out.ingest_ref).toBe('mbox-abc-42');
    expect(out.status).toBe('completed');
  });

  test('throws when email_id is missing', () => {
    const bad = { ...validResult, email_id: undefined };
    expect(() => validateEmailIngestResult(bad as unknown as Record<string, unknown>)).toThrow(
      /email_id/,
    );
  });

  test('throws when email_id is not a string', () => {
    const bad = { ...validResult, email_id: 42 };
    expect(() => validateEmailIngestResult(bad as unknown as Record<string, unknown>)).toThrow(
      /email_id/,
    );
  });

  test('throws when chunk_ids is missing', () => {
    const bad = { ...validResult, chunk_ids: undefined };
    expect(() => validateEmailIngestResult(bad as unknown as Record<string, unknown>)).toThrow(
      /chunk_ids/,
    );
  });

  test('throws when chunk_ids is not an array', () => {
    const bad = { ...validResult, chunk_ids: 'not-an-array' };
    expect(() => validateEmailIngestResult(bad as unknown as Record<string, unknown>)).toThrow(
      /chunk_ids/,
    );
  });

  test('throws when chunk_count is missing', () => {
    const bad = { ...validResult, chunk_count: undefined };
    expect(() => validateEmailIngestResult(bad as unknown as Record<string, unknown>)).toThrow(
      /chunk_count/,
    );
  });

  test('throws when chunk_count is not a number', () => {
    const bad = { ...validResult, chunk_count: '5' };
    expect(() => validateEmailIngestResult(bad as unknown as Record<string, unknown>)).toThrow(
      /chunk_count/,
    );
  });

  test('throws when ingest_ref is missing', () => {
    const bad = { ...validResult, ingest_ref: undefined };
    expect(() => validateEmailIngestResult(bad as unknown as Record<string, unknown>)).toThrow(
      /ingest_ref/,
    );
  });

  test('accepts empty chunk_ids array (zero-chunk email body)', () => {
    const empty = { ...validResult, chunk_ids: [], chunk_count: 0 };
    const out = validateEmailIngestResult(empty);
    expect(out.chunk_ids).toHaveLength(0);
    expect(out.chunk_count).toBe(0);
  });

  test('passes through extra fields without stripping them', () => {
    const withExtra = { ...validResult, extra_field: 'preserved' };
    const out = validateEmailIngestResult(withExtra);
    expect((out as Record<string, unknown>)['extra_field']).toBe('preserved');
  });
});

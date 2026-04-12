/**
 * Unit tests for the email_ingest job handler.
 *
 * Tests pure helper functions without spawning real IMAP connections.
 * Integration tests (real Greenmail) live in tests/integration/imap-ingest.test.ts.
 */

import { describe, test, expect } from 'vitest';
import {
  EMAIL_INGEST_JOB_TYPE,
  resolveImapConfig,
  buildEmailIngestPayload,
  validateEmailIngestResult,
} from '../../src/email-ingest-job';

describe('EMAIL_INGEST_JOB_TYPE', () => {
  test('equals email_ingest', () => {
    expect(EMAIL_INGEST_JOB_TYPE).toBe('email_ingest');
  });
});

describe('resolveImapConfig', () => {
  test('resolves all fields from environment', () => {
    const cfg = resolveImapConfig({
      IMAP_HOST: 'imap.example.com',
      IMAP_PORT: '993',
      IMAP_SECURE: 'true',
      IMAP_USER: 'user@example.com',
      IMAP_PASSWORD: 'secret',
    });
    expect(cfg).toEqual({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'user@example.com',
      password: 'secret',
      tlsRejectUnauthorized: true,
    });
  });

  test('defaults secure to true when IMAP_SECURE is not set', () => {
    const cfg = resolveImapConfig({
      IMAP_HOST: 'imap.example.com',
      IMAP_PORT: '993',
      IMAP_USER: 'user@example.com',
      IMAP_PASSWORD: 'secret',
    });
    expect(cfg.secure).toBe(true);
  });

  test('sets secure=false when IMAP_SECURE=false', () => {
    const cfg = resolveImapConfig({
      IMAP_HOST: 'localhost',
      IMAP_PORT: '3143',
      IMAP_SECURE: 'false',
      IMAP_USER: 'u',
      IMAP_PASSWORD: 'p',
    });
    expect(cfg.secure).toBe(false);
  });

  test('sets tlsRejectUnauthorized=false when env var is false', () => {
    const cfg = resolveImapConfig({
      IMAP_HOST: 'localhost',
      IMAP_PORT: '3143',
      IMAP_USER: 'u',
      IMAP_PASSWORD: 'p',
      IMAP_TLS_REJECT_UNAUTHORIZED: 'false',
    });
    expect(cfg.tlsRejectUnauthorized).toBe(false);
  });

  test('throws when IMAP_HOST is missing', () => {
    expect(() =>
      resolveImapConfig({ IMAP_PORT: '993', IMAP_USER: 'u', IMAP_PASSWORD: 'p' }),
    ).toThrow('IMAP_HOST');
  });

  test('throws when IMAP_PORT is missing', () => {
    expect(() => resolveImapConfig({ IMAP_HOST: 'h', IMAP_USER: 'u', IMAP_PASSWORD: 'p' })).toThrow(
      'IMAP_PORT',
    );
  });

  test('throws when IMAP_USER is missing', () => {
    expect(() =>
      resolveImapConfig({ IMAP_HOST: 'h', IMAP_PORT: '993', IMAP_PASSWORD: 'p' }),
    ).toThrow('IMAP_USER');
  });

  test('throws when IMAP_PASSWORD is missing', () => {
    expect(() => resolveImapConfig({ IMAP_HOST: 'h', IMAP_PORT: '993', IMAP_USER: 'u' })).toThrow(
      'IMAP_PASSWORD',
    );
  });

  test('throws when IMAP_PORT is not a valid number', () => {
    expect(() =>
      resolveImapConfig({
        IMAP_HOST: 'h',
        IMAP_PORT: 'abc',
        IMAP_USER: 'u',
        IMAP_PASSWORD: 'p',
      }),
    ).toThrow('IMAP_PORT');
  });

  test('throws when IMAP_PORT is out of range', () => {
    expect(() =>
      resolveImapConfig({
        IMAP_HOST: 'h',
        IMAP_PORT: '99999',
        IMAP_USER: 'u',
        IMAP_PASSWORD: 'p',
      }),
    ).toThrow('IMAP_PORT');
  });
});

describe('buildEmailIngestPayload', () => {
  test('builds payload with default since_uid and batch_size', () => {
    const p = buildEmailIngestPayload('my-mailbox');
    expect(p).toEqual({
      mailbox_ref: 'my-mailbox',
      since_uid: 0,
      batch_size: 50,
    });
  });

  test('accepts custom since_uid and batch_size', () => {
    const p = buildEmailIngestPayload('ref', 42, 10);
    expect(p).toEqual({
      mailbox_ref: 'ref',
      since_uid: 42,
      batch_size: 10,
    });
  });
});

describe('validateEmailIngestResult', () => {
  test('validates a well-formed completed result', () => {
    const raw = {
      status: 'completed',
      fetched_count: 5,
      failed_uids: [101],
      highest_uid: 200,
      mailbox_ref: 'primary',
    };
    const r = validateEmailIngestResult(raw);
    expect(r.fetched_count).toBe(5);
    expect(r.failed_uids).toEqual([101]);
    expect(r.highest_uid).toBe(200);
    expect(r.mailbox_ref).toBe('primary');
  });

  test('validates a permanent-failure result', () => {
    const raw = {
      status: 'failed',
      fetched_count: 0,
      failed_uids: [],
      highest_uid: 0,
      mailbox_ref: 'primary',
      permanent: true,
      error: 'Permanent IMAP error: Authentication failed',
    };
    const r = validateEmailIngestResult(raw);
    expect(r.permanent).toBe(true);
    expect(r.status).toBe('failed');
  });

  test('throws when fetched_count is missing', () => {
    expect(() =>
      validateEmailIngestResult({ failed_uids: [], highest_uid: 0, mailbox_ref: 'x' }),
    ).toThrow('fetched_count');
  });

  test('throws when fetched_count is not a number', () => {
    expect(() =>
      validateEmailIngestResult({
        fetched_count: 'five',
        failed_uids: [],
        highest_uid: 0,
        mailbox_ref: 'x',
      }),
    ).toThrow('fetched_count');
  });

  test('throws when failed_uids is missing', () => {
    expect(() =>
      validateEmailIngestResult({ fetched_count: 0, highest_uid: 0, mailbox_ref: 'x' }),
    ).toThrow('failed_uids');
  });

  test('throws when failed_uids is not an array', () => {
    expect(() =>
      validateEmailIngestResult({
        fetched_count: 0,
        failed_uids: 'none',
        highest_uid: 0,
        mailbox_ref: 'x',
      }),
    ).toThrow('failed_uids');
  });

  test('throws when highest_uid is missing', () => {
    expect(() =>
      validateEmailIngestResult({ fetched_count: 0, failed_uids: [], mailbox_ref: 'x' }),
    ).toThrow('highest_uid');
  });

  test('throws when mailbox_ref is missing', () => {
    expect(() =>
      validateEmailIngestResult({ fetched_count: 0, failed_uids: [], highest_uid: 0 }),
    ).toThrow('mailbox_ref');
  });
});

describe('classifyImapError (via import)', () => {
  test('can import classifyImapError from core/imap-etl-worker', async () => {
    const { classifyImapError } = await import('core/imap-etl-worker');
    expect(typeof classifyImapError).toBe('function');
  });
});

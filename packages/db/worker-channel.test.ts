/**
 * Unit tests for the split-channel worker credential model.
 *
 * Tests role name validation and credential pair creation.
 */

import { describe, test, expect } from 'vitest';
import {
  assertQueueCredentialScope,
  createChannelCredentials,
  type WorkerChannelCredentials,
} from './worker-channel';

// ---------------------------------------------------------------------------
// assertQueueCredentialScope
// ---------------------------------------------------------------------------

describe('assertQueueCredentialScope', () => {
  test('accepts a URL with the correct per-type agent role', () => {
    expect(() =>
      assertQueueCredentialScope('postgres://agent_email_ingest:pw@localhost/db', 'email_ingest'),
    ).not.toThrow();
  });

  test('accepts agent_annotation for annotation type', () => {
    expect(() =>
      assertQueueCredentialScope('postgres://agent_annotation:pw@localhost/db', 'annotation'),
    ).not.toThrow();
  });

  test('throws when role does not match agent type', () => {
    expect(() =>
      assertQueueCredentialScope('postgres://agent_annotation:pw@localhost/db', 'email_ingest'),
    ).toThrow(/role mismatch/);
  });

  test('throws when a non-agent role is used', () => {
    expect(() =>
      assertQueueCredentialScope('postgres://app_rw:pw@localhost/db', 'email_ingest'),
    ).toThrow(/role mismatch/);
  });

  test('throws when URL is malformed', () => {
    expect(() => assertQueueCredentialScope('not-a-url', 'email_ingest')).toThrow(/not a valid/);
  });

  test('error message includes agent type', () => {
    expect(() =>
      assertQueueCredentialScope('postgres://wrong_role:pw@localhost/db', 'email_ingest'),
    ).toThrow(/"email_ingest"/);
  });

  test('error message includes expected role name', () => {
    expect(() =>
      assertQueueCredentialScope('postgres://wrong_role:pw@localhost/db', 'email_ingest'),
    ).toThrow(/agent_email_ingest/);
  });
});

// ---------------------------------------------------------------------------
// createChannelCredentials
// ---------------------------------------------------------------------------

describe('createChannelCredentials', () => {
  const VALID_URL = 'postgres://agent_email_ingest:pw@localhost/db';

  test('returns a valid credential pair when inputs are correct', () => {
    const creds = createChannelCredentials(VALID_URL, 'jwt-token', 'email_ingest', 'task-001');
    expect(creds.queueDatabaseUrl).toBe(VALID_URL);
    expect(creds.delegatedToken).toBe('jwt-token');
    expect(creds.agentType).toBe('email_ingest');
    expect(creds.taskId).toBe('task-001');
  });

  test('throws when queue URL role does not match agent type', () => {
    expect(() =>
      createChannelCredentials(
        'postgres://agent_annotation:pw@localhost/db',
        'jwt-token',
        'email_ingest',
        'task-001',
      ),
    ).toThrow(/role mismatch/);
  });

  test('the returned object satisfies the WorkerChannelCredentials interface', () => {
    const creds: WorkerChannelCredentials = createChannelCredentials(
      VALID_URL,
      'jwt-token',
      'email_ingest',
      'task-002',
    );
    expect(creds).toHaveProperty('queueDatabaseUrl');
    expect(creds).toHaveProperty('delegatedToken');
    expect(creds).toHaveProperty('agentType');
    expect(creds).toHaveProperty('taskId');
  });
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

describe('worker-channel module exports', () => {
  test('assertQueueCredentialScope is a function', () => {
    expect(typeof assertQueueCredentialScope).toBe('function');
  });

  test('createChannelCredentials is a function', () => {
    expect(typeof createChannelCredentials).toBe('function');
  });
});

import { describe, expect, test } from 'vitest';
import { computeAuditHash } from './audit';

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

describe('computeAuditHash', () => {
  test('returns a 64-character hex string', async () => {
    const hash = await computeAuditHash(GENESIS_HASH, {
      actor_id: 'user-1',
      action: 'task.update',
      entity_type: 'task',
      entity_id: 'task-1',
      before: null,
      after: { status: 'done' },
      ts: '2026-01-01T00:00:00.000Z',
    });
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test('is deterministic for the same inputs', async () => {
    const payload = {
      actor_id: 'user-2',
      action: 'task.update',
      entity_type: 'task',
      entity_id: 'task-99',
      before: { status: 'todo' },
      after: { status: 'in_progress' },
      ts: '2026-03-01T12:00:00.000Z',
    };
    const h1 = await computeAuditHash(GENESIS_HASH, payload);
    const h2 = await computeAuditHash(GENESIS_HASH, payload);
    expect(h1).toBe(h2);
  });

  test('produces different hashes for different prev_hash values', async () => {
    const payload = {
      actor_id: 'user-1',
      action: 'task.update',
      entity_type: 'task',
      entity_id: 'task-1',
      before: null,
      after: null,
      ts: '2026-01-01T00:00:00.000Z',
    };
    const h1 = await computeAuditHash(GENESIS_HASH, payload);
    const h2 = await computeAuditHash('abcd1234', payload);
    expect(h1).not.toBe(h2);
  });

  test('produces different hashes when payload differs', async () => {
    const base = {
      actor_id: 'user-1',
      action: 'task.update',
      entity_type: 'task',
      entity_id: 'task-1',
      before: null,
      after: { status: 'todo' },
      ts: '2026-01-01T00:00:00.000Z',
    };
    const h1 = await computeAuditHash(GENESIS_HASH, base);
    const h2 = await computeAuditHash(GENESIS_HASH, { ...base, after: { status: 'done' } });
    expect(h1).not.toBe(h2);
  });

  test('chains correctly — second row prev_hash equals first row hash', async () => {
    const payload1 = {
      actor_id: 'user-1',
      action: 'task.create',
      entity_type: 'task',
      entity_id: 'task-1',
      before: null,
      after: { name: 'First task' },
      ts: '2026-01-01T00:00:00.000Z',
    };
    const hash1 = await computeAuditHash(GENESIS_HASH, payload1);

    const payload2 = {
      actor_id: 'user-1',
      action: 'task.update',
      entity_type: 'task',
      entity_id: 'task-1',
      before: { name: 'First task' },
      after: { name: 'Updated task' },
      ts: '2026-01-02T00:00:00.000Z',
    };
    const hash2 = await computeAuditHash(hash1, payload2);

    // Recompute hash2 from scratch using hash1 as prev — must be identical
    const hash2Again = await computeAuditHash(hash1, payload2);
    expect(hash2).toBe(hash2Again);

    // Tampering with hash1 breaks the chain for hash2
    const hash2Tampered = await computeAuditHash('tampered', payload2);
    expect(hash2Tampered).not.toBe(hash2);
  });
});

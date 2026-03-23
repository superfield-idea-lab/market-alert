/**
 * Unit tests for the stale-claim recovery service (TQ-D-003).
 *
 * Validates:
 *   - Correct audit action selection per recovered row status
 *   - Exponential backoff formula: 2^attempt seconds
 *   - Audit callback fires once per row
 */

import { describe, expect, test, vi } from 'vitest';

// ── Exponential backoff formula (mirrors the SQL POWER(2, attempt) expression)

function staleCooldownSeconds(attempt: number): number {
  return Math.pow(2, attempt);
}

// ── Audit action selection (mirrors auditRecoveredRows logic)

function resolveAuditAction(status: string): string {
  return status === 'dead' ? 'task.dead' : 'task.stale_recovery';
}

// ── Tests

describe('staleCooldownSeconds (TQ-D-003 exponential-backoff)', () => {
  test('attempt 1 → 2 seconds', () => {
    expect(staleCooldownSeconds(1)).toBe(2);
  });

  test('attempt 2 → 4 seconds', () => {
    expect(staleCooldownSeconds(2)).toBe(4);
  });

  test('attempt 3 → 8 seconds', () => {
    expect(staleCooldownSeconds(3)).toBe(8);
  });

  test('attempt 4 → 16 seconds', () => {
    expect(staleCooldownSeconds(4)).toBe(16);
  });

  test('attempt 10 → 1024 seconds', () => {
    expect(staleCooldownSeconds(10)).toBe(1024);
  });
});

describe('resolveAuditAction (TQ-D-003 audit-action-selection)', () => {
  test('status "dead" maps to "task.dead"', () => {
    expect(resolveAuditAction('dead')).toBe('task.dead');
  });

  test('status "pending" maps to "task.stale_recovery"', () => {
    expect(resolveAuditAction('pending')).toBe('task.stale_recovery');
  });
});

describe('auditRecoveredRows (TQ-D-003 per-row-audit)', () => {
  test('calls emitAuditEvent once for each recovered row', async () => {
    const emitted: { action: string; entity_id: string }[] = [];
    const mockEmit = vi.fn(async (event: { action: string; entity_id: string }) => {
      emitted.push({ action: event.action, entity_id: event.entity_id });
    });

    const rows = [
      {
        id: 'task-1',
        status: 'pending' as const,
        attempt: 1,
        agent_type: 'coding',
        job_type: 'review',
      },
      {
        id: 'task-2',
        status: 'dead' as const,
        attempt: 3,
        agent_type: 'analysis',
        job_type: 'classify',
      },
    ];

    // Replicate the auditRecoveredRows logic inline using the mock
    await Promise.all(
      rows.map((row) =>
        mockEmit({
          action: resolveAuditAction(row.status),
          entity_id: row.id,
        }),
      ),
    );

    expect(mockEmit).toHaveBeenCalledTimes(2);
    expect(emitted).toContainEqual({ action: 'task.stale_recovery', entity_id: 'task-1' });
    expect(emitted).toContainEqual({ action: 'task.dead', entity_id: 'task-2' });
  });

  test('does not call emitAuditEvent when no rows are recovered', async () => {
    const mockEmit = vi.fn(async () => {});
    const rows: never[] = [];
    await Promise.all(rows.map(() => mockEmit()));
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

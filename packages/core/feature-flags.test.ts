/**
 * Unit tests for the pure evaluateFlag helper (packages/core/feature-flags.ts).
 *
 * These tests cover the scheduled_disable_at business rule without any
 * database dependency (TEST-C-018: no mocks required for pure functions).
 *
 * Issue #6 test plan item TP3:
 *   "Unit test: evaluateFlag returns false when scheduled_disable_at is in the past"
 *
 * Blueprint refs: PRUNE-D-002, TEST-C-018
 */

import { describe, test, expect } from 'vitest';
import { evaluateFlag, MKT_FLAG_KEYS } from './feature-flags';
import type { FlagRow } from './feature-flags';

const NOW = new Date('2026-05-03T12:00:00Z');
const PAST = new Date('2026-05-03T11:59:59Z');
const FUTURE = new Date('2026-05-03T12:00:01Z');

describe('evaluateFlag — pure logic (issue #6, TP3)', () => {
  test('returns false when flag is null (row not found)', () => {
    expect(evaluateFlag(null, NOW)).toBe(false);
  });

  test('returns false when enabled is false', () => {
    const flag: FlagRow = { enabled: false, scheduled_disable_at: null };
    expect(evaluateFlag(flag, NOW)).toBe(false);
  });

  test('returns true when enabled is true and scheduled_disable_at is null', () => {
    const flag: FlagRow = { enabled: true, scheduled_disable_at: null };
    expect(evaluateFlag(flag, NOW)).toBe(true);
  });

  test('returns false when scheduled_disable_at is exactly now (TP3)', () => {
    const flag: FlagRow = { enabled: true, scheduled_disable_at: NOW };
    expect(evaluateFlag(flag, NOW)).toBe(false);
  });

  test('returns false when scheduled_disable_at is in the past (TP3)', () => {
    const flag: FlagRow = { enabled: true, scheduled_disable_at: PAST };
    expect(evaluateFlag(flag, NOW)).toBe(false);
  });

  test('returns true when scheduled_disable_at is in the future', () => {
    const flag: FlagRow = { enabled: true, scheduled_disable_at: FUTURE };
    expect(evaluateFlag(flag, NOW)).toBe(true);
  });

  test('returns false when enabled=false even with future scheduled_disable_at', () => {
    const flag: FlagRow = { enabled: false, scheduled_disable_at: FUTURE };
    expect(evaluateFlag(flag, NOW)).toBe(false);
  });
});

describe('MKT_FLAG_KEYS constant', () => {
  test('contains all 5 v1 flag keys', () => {
    expect(MKT_FLAG_KEYS).toContain('edgar_ingest');
    expect(MKT_FLAG_KEYS).toContain('alert_notify_email');
    expect(MKT_FLAG_KEYS).toContain('alert_notify_sms');
    expect(MKT_FLAG_KEYS).toContain('alert_notify_webhook');
    expect(MKT_FLAG_KEYS).toContain('trade_lifecycle');
    expect(MKT_FLAG_KEYS.length).toBe(5);
  });
});

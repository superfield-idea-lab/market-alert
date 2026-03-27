/**
 * Unit tests for the agent timeout configuration module.
 *
 * Tests cover:
 * - Default timeout fallback
 * - Global AGENT_TIMEOUT_MS override
 * - Per-agent-type AGENT_TIMEOUT_MS_<TYPE> override
 * - Agent type name normalisation (uppercase, special chars → _)
 * - SIGTERM grace period resolution
 */

import { describe, test, expect } from 'vitest';
import {
  resolveAgentTimeoutMs,
  resolveSigtermGraceMs,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_SIGTERM_GRACE_MS,
} from '../../src/timeout.js';

// ---------------------------------------------------------------------------
// resolveAgentTimeoutMs
// ---------------------------------------------------------------------------

describe('resolveAgentTimeoutMs — defaults', () => {
  test('returns DEFAULT_AGENT_TIMEOUT_MS when no env vars are set', () => {
    expect(resolveAgentTimeoutMs('coding', {})).toBe(DEFAULT_AGENT_TIMEOUT_MS);
  });

  test('DEFAULT_AGENT_TIMEOUT_MS is 600 000 ms (10 minutes)', () => {
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(600_000);
  });
});

describe('resolveAgentTimeoutMs — global override', () => {
  test('uses AGENT_TIMEOUT_MS when set', () => {
    expect(resolveAgentTimeoutMs('coding', { AGENT_TIMEOUT_MS: '120000' })).toBe(120_000);
  });

  test('ignores AGENT_TIMEOUT_MS when value is not a positive integer', () => {
    expect(resolveAgentTimeoutMs('coding', { AGENT_TIMEOUT_MS: 'abc' })).toBe(
      DEFAULT_AGENT_TIMEOUT_MS,
    );
  });

  test('ignores AGENT_TIMEOUT_MS when value is zero', () => {
    expect(resolveAgentTimeoutMs('coding', { AGENT_TIMEOUT_MS: '0' })).toBe(
      DEFAULT_AGENT_TIMEOUT_MS,
    );
  });

  test('ignores AGENT_TIMEOUT_MS when value is negative', () => {
    expect(resolveAgentTimeoutMs('coding', { AGENT_TIMEOUT_MS: '-1000' })).toBe(
      DEFAULT_AGENT_TIMEOUT_MS,
    );
  });
});

describe('resolveAgentTimeoutMs — per-agent-type override', () => {
  test('uses AGENT_TIMEOUT_MS_CODING for agent type "coding"', () => {
    expect(resolveAgentTimeoutMs('coding', { AGENT_TIMEOUT_MS_CODING: '300000' })).toBe(300_000);
  });

  test('per-type override takes precedence over global override', () => {
    expect(
      resolveAgentTimeoutMs('coding', {
        AGENT_TIMEOUT_MS: '120000',
        AGENT_TIMEOUT_MS_CODING: '300000',
      }),
    ).toBe(300_000);
  });

  test('uppercases agent type name for env var lookup', () => {
    expect(resolveAgentTimeoutMs('analysis', { AGENT_TIMEOUT_MS_ANALYSIS: '180000' })).toBe(
      180_000,
    );
  });

  test('replaces hyphens with underscores in agent type name', () => {
    expect(resolveAgentTimeoutMs('my-agent', { AGENT_TIMEOUT_MS_MY_AGENT: '90000' })).toBe(90_000);
  });

  test('replaces dots with underscores in agent type name', () => {
    expect(resolveAgentTimeoutMs('my.agent', { AGENT_TIMEOUT_MS_MY_AGENT: '90000' })).toBe(90_000);
  });

  test('falls back to global when per-type value is invalid', () => {
    expect(
      resolveAgentTimeoutMs('coding', {
        AGENT_TIMEOUT_MS: '120000',
        AGENT_TIMEOUT_MS_CODING: 'not-a-number',
      }),
    ).toBe(120_000);
  });

  test('falls back to default when per-type is missing and global is unset', () => {
    expect(resolveAgentTimeoutMs('unknown-type', {})).toBe(DEFAULT_AGENT_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// resolveSigtermGraceMs
// ---------------------------------------------------------------------------

describe('resolveSigtermGraceMs', () => {
  test('returns DEFAULT_SIGTERM_GRACE_MS when env var is not set', () => {
    expect(resolveSigtermGraceMs({})).toBe(DEFAULT_SIGTERM_GRACE_MS);
  });

  test('DEFAULT_SIGTERM_GRACE_MS is 5 000 ms', () => {
    expect(DEFAULT_SIGTERM_GRACE_MS).toBe(5_000);
  });

  test('uses AGENT_TIMEOUT_SIGTERM_GRACE_MS when set', () => {
    expect(resolveSigtermGraceMs({ AGENT_TIMEOUT_SIGTERM_GRACE_MS: '2000' })).toBe(2_000);
  });

  test('allows zero grace period (immediate SIGKILL)', () => {
    expect(resolveSigtermGraceMs({ AGENT_TIMEOUT_SIGTERM_GRACE_MS: '0' })).toBe(0);
  });

  test('ignores invalid value and returns default', () => {
    expect(resolveSigtermGraceMs({ AGENT_TIMEOUT_SIGTERM_GRACE_MS: 'bad' })).toBe(
      DEFAULT_SIGTERM_GRACE_MS,
    );
  });

  test('ignores negative value and returns default', () => {
    expect(resolveSigtermGraceMs({ AGENT_TIMEOUT_SIGTERM_GRACE_MS: '-100' })).toBe(
      DEFAULT_SIGTERM_GRACE_MS,
    );
  });
});

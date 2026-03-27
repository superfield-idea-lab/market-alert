/**
 * Unit tests for the security vulnerability scanner job module.
 *
 * Validates:
 *   - SECURITY_SCAN_JOB_TYPE constant
 *   - buildSecurityScanCliPayload merges fields correctly
 *   - validateSecurityScanResult accepts valid results and rejects invalid ones
 *   - Findings validation checks all required fields
 *   - SECURITY_SCAN_TIMEOUT_MS is a positive number
 */

import { describe, test, expect } from 'vitest';
import {
  SECURITY_SCAN_JOB_TYPE,
  SECURITY_SCAN_TIMEOUT_MS,
  SECURITY_SCAN_PROMPT,
  buildSecurityScanCliPayload,
  validateSecurityScanResult,
} from '../../src/security-scanner-job';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('SECURITY_SCAN_JOB_TYPE', () => {
  test('equals "security_scan"', () => {
    expect(SECURITY_SCAN_JOB_TYPE).toBe('security_scan');
  });
});

describe('SECURITY_SCAN_TIMEOUT_MS', () => {
  test('is a positive number', () => {
    expect(typeof SECURITY_SCAN_TIMEOUT_MS).toBe('number');
    expect(SECURITY_SCAN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test('is at least 5 minutes', () => {
    expect(SECURITY_SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60 * 1_000);
  });
});

describe('SECURITY_SCAN_PROMPT', () => {
  test('is a non-empty string', () => {
    expect(typeof SECURITY_SCAN_PROMPT).toBe('string');
    expect(SECURITY_SCAN_PROMPT.length).toBeGreaterThan(100);
  });

  test('mentions OWASP', () => {
    expect(SECURITY_SCAN_PROMPT).toMatch(/owasp/i);
  });

  test('mentions injection', () => {
    expect(SECURITY_SCAN_PROMPT).toMatch(/injection/i);
  });

  test('mentions read-only', () => {
    expect(SECURITY_SCAN_PROMPT).toMatch(/read.only/i);
  });
});

// ---------------------------------------------------------------------------
// buildSecurityScanCliPayload
// ---------------------------------------------------------------------------

describe('buildSecurityScanCliPayload', () => {
  test('includes id, job_type, and agent_type', () => {
    const payload = buildSecurityScanCliPayload('task-123', 'security', { scan_ref: 'ref-1' });
    expect(payload['id']).toBe('task-123');
    expect(payload['job_type']).toBe(SECURITY_SCAN_JOB_TYPE);
    expect(payload['agent_type']).toBe('security');
  });

  test('spreads payload fields', () => {
    const payload = buildSecurityScanCliPayload('task-456', 'security', {
      scan_ref: 'ref-2',
      repo_ref: 'repo-abc',
    });
    expect(payload['scan_ref']).toBe('ref-2');
    expect(payload['repo_ref']).toBe('repo-abc');
  });

  test('includes the security prompt', () => {
    const payload = buildSecurityScanCliPayload('task-789', 'security', { scan_ref: 'ref-3' });
    expect(typeof payload['prompt']).toBe('string');
    expect((payload['prompt'] as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// validateSecurityScanResult
// ---------------------------------------------------------------------------

function makeValidResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findings: [
      {
        severity: 'high',
        path: 'apps/server/src/auth/jwt.ts',
        lines: { start: 42, end: 55 },
        category: 'auth',
        description: 'Weak JWT signing algorithm.',
        remediation: 'Use RS256 instead of HS256.',
      },
    ],
    summary: 'Found 0 critical, 1 high issue(s).',
    status: 'completed',
    scan_ref: 'scan-ref-001',
    ...overrides,
  };
}

describe('validateSecurityScanResult', () => {
  test('accepts a valid result with findings', () => {
    const result = validateSecurityScanResult(makeValidResult());
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBe('Found 0 critical, 1 high issue(s).');
    expect(result.scan_ref).toBe('scan-ref-001');
    expect(result.status).toBe('completed');
  });

  test('accepts an empty findings array', () => {
    const result = validateSecurityScanResult(makeValidResult({ findings: [] }));
    expect(result.findings).toHaveLength(0);
  });

  test('throws when findings is missing', () => {
    const raw = makeValidResult();
    delete raw['findings'];
    expect(() => validateSecurityScanResult(raw)).toThrow(/"findings" array/);
  });

  test('throws when findings is not an array', () => {
    expect(() => validateSecurityScanResult(makeValidResult({ findings: 'bad' }))).toThrow(
      /"findings" array/,
    );
  });

  test('throws when summary is missing', () => {
    const raw = makeValidResult();
    delete raw['summary'];
    expect(() => validateSecurityScanResult(raw)).toThrow(/"summary" string/);
  });

  test('throws when scan_ref is missing', () => {
    const raw = makeValidResult();
    delete raw['scan_ref'];
    expect(() => validateSecurityScanResult(raw)).toThrow(/"scan_ref" string/);
  });

  test('throws when a finding is missing severity', () => {
    const findings = [
      {
        path: 'foo.ts',
        lines: { start: 1, end: 2 },
        category: 'xss',
        description: 'XSS in output.',
        remediation: 'Escape output.',
      },
    ];
    expect(() => validateSecurityScanResult(makeValidResult({ findings }))).toThrow(/severity/);
  });

  test('throws when a finding is missing path', () => {
    const findings = [
      {
        severity: 'low',
        lines: { start: 1, end: 2 },
        category: 'info',
        description: 'Info.',
        remediation: 'No action needed.',
      },
    ];
    expect(() => validateSecurityScanResult(makeValidResult({ findings }))).toThrow(/path/);
  });

  test('throws when a finding is missing lines', () => {
    const findings = [
      {
        severity: 'medium',
        path: 'bar.ts',
        category: 'csrf',
        description: 'CSRF missing.',
        remediation: 'Add CSRF token.',
      },
    ];
    expect(() => validateSecurityScanResult(makeValidResult({ findings }))).toThrow(/lines/);
  });

  test('throws when a finding is missing description', () => {
    const findings = [
      {
        severity: 'low',
        path: 'baz.ts',
        lines: { start: 1, end: 1 },
        category: 'misc',
        remediation: 'Fix it.',
      },
    ];
    expect(() => validateSecurityScanResult(makeValidResult({ findings }))).toThrow(/description/);
  });

  test('throws when a finding is missing remediation', () => {
    const findings = [
      {
        severity: 'info',
        path: 'qux.ts',
        lines: { start: 10, end: 15 },
        category: 'misc',
        description: 'Informational finding.',
      },
    ];
    expect(() => validateSecurityScanResult(makeValidResult({ findings }))).toThrow(/remediation/);
  });

  test('passes through extra fields from vendor', () => {
    const result = validateSecurityScanResult(makeValidResult({ stub: true, custom_field: 42 }));
    expect(result['stub']).toBe(true);
    expect(result['custom_field']).toBe(42);
  });
});

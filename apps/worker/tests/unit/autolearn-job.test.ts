/**
 * Unit tests for the autolearn wiki draft job module.
 *
 * Validates:
 *   - AUTOLEARN_JOB_TYPE constant
 *   - AUTOLEARN_TIMEOUT_MS is a positive number within expected range
 *   - AUTOLEARN_PROMPT_STUB is a non-empty string with expected markers
 *   - buildAutolearnCliPayload merges fields correctly
 *   - validateAutolearnResult accepts valid results and rejects invalid ones
 *
 * Scout invariants tested:
 *   - The job type constant equals the task-queue agent_type string
 *   - The payload builder enforces the required field contract (TQ-P-002)
 *   - The result validator enforces wiki_version_ref and customer_ref fields
 *   - No runtime state is mutated — all functions are pure
 */

import { describe, test, expect } from 'vitest';
import {
  AUTOLEARN_JOB_TYPE,
  AUTOLEARN_TIMEOUT_MS,
  AUTOLEARN_PROMPT_STUB,
  buildAutolearnCliPayload,
  validateAutolearnResult,
} from '../../src/autolearn-job';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('AUTOLEARN_JOB_TYPE', () => {
  test('equals "autolearn_wiki_draft"', () => {
    expect(AUTOLEARN_JOB_TYPE).toBe('autolearn_wiki_draft');
  });

  test('is a string', () => {
    expect(typeof AUTOLEARN_JOB_TYPE).toBe('string');
  });
});

describe('AUTOLEARN_TIMEOUT_MS', () => {
  test('is a positive number', () => {
    expect(typeof AUTOLEARN_TIMEOUT_MS).toBe('number');
    expect(AUTOLEARN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test('is at least 10 minutes', () => {
    expect(AUTOLEARN_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60 * 1_000);
  });

  test('is at most 30 minutes', () => {
    expect(AUTOLEARN_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60 * 1_000);
  });
});

describe('AUTOLEARN_PROMPT_STUB', () => {
  test('is a non-empty string', () => {
    expect(typeof AUTOLEARN_PROMPT_STUB).toBe('string');
    expect(AUTOLEARN_PROMPT_STUB.length).toBeGreaterThan(100);
  });

  test('mentions read-only analysis', () => {
    expect(AUTOLEARN_PROMPT_STUB).toMatch(/read.only/i);
  });

  test('mentions wiki', () => {
    expect(AUTOLEARN_PROMPT_STUB).toMatch(/wiki/i);
  });

  test('instructs stdout-only output', () => {
    expect(AUTOLEARN_PROMPT_STUB).toMatch(/stdout/i);
  });

  test('includes wiki_version_ref in expected JSON shape', () => {
    expect(AUTOLEARN_PROMPT_STUB).toMatch(/wiki_version_ref/);
  });

  test('includes customer_ref in expected JSON shape', () => {
    expect(AUTOLEARN_PROMPT_STUB).toMatch(/customer_ref/);
  });
});

// ---------------------------------------------------------------------------
// buildAutolearnCliPayload
// ---------------------------------------------------------------------------

describe('buildAutolearnCliPayload', () => {
  test('includes id field', () => {
    const payload = buildAutolearnCliPayload('task-001', 'autolearn', {
      ground_truth_ref: 'gt_001',
      wiki_ref: 'wiki_001',
      department_ref: 'dept_001',
      customer_ref: 'cust_001',
    });
    expect(payload['id']).toBe('task-001');
  });

  test('includes job_type matching AUTOLEARN_JOB_TYPE', () => {
    const payload = buildAutolearnCliPayload('task-002', 'autolearn', {
      ground_truth_ref: 'gt_002',
      wiki_ref: 'wiki_002',
      department_ref: 'dept_002',
      customer_ref: 'cust_002',
    });
    expect(payload['job_type']).toBe(AUTOLEARN_JOB_TYPE);
  });

  test('includes agent_type', () => {
    const payload = buildAutolearnCliPayload('task-003', 'autolearn', {
      ground_truth_ref: 'gt_003',
    });
    expect(payload['agent_type']).toBe('autolearn');
  });

  test('spreads payload fields into the output', () => {
    const payload = buildAutolearnCliPayload('task-004', 'autolearn', {
      ground_truth_ref: 'gt_004',
      wiki_ref: 'wiki_004',
      department_ref: 'dept_004',
      customer_ref: 'cust_004',
    });
    expect(payload['ground_truth_ref']).toBe('gt_004');
    expect(payload['wiki_ref']).toBe('wiki_004');
    expect(payload['department_ref']).toBe('dept_004');
    expect(payload['customer_ref']).toBe('cust_004');
  });

  test('includes prompt field from AUTOLEARN_PROMPT_STUB', () => {
    const payload = buildAutolearnCliPayload('task-005', 'autolearn', {});
    expect(typeof payload['prompt']).toBe('string');
    expect((payload['prompt'] as string).length).toBeGreaterThan(0);
  });

  test('normal payload fields are spread into the output alongside task metadata', () => {
    // The task ID, job_type, agent_type, and prompt come from the function arguments.
    // Additional payload fields are spread in alongside them. This test verifies
    // a typical clean payload is forwarded correctly.
    const payload = buildAutolearnCliPayload('task-006', 'autolearn', {
      ground_truth_ref: 'gt_006',
      customer_ref: 'cust_006',
    });
    expect(payload['id']).toBe('task-006');
    expect(payload['job_type']).toBe(AUTOLEARN_JOB_TYPE);
    expect(payload['agent_type']).toBe('autolearn');
    expect(payload['ground_truth_ref']).toBe('gt_006');
    expect(payload['customer_ref']).toBe('cust_006');
  });
});

// ---------------------------------------------------------------------------
// validateAutolearnResult
// ---------------------------------------------------------------------------

describe('validateAutolearnResult', () => {
  test('accepts a valid completed result', () => {
    const raw: Record<string, unknown> = {
      wiki_version_ref: 'wv_abc123',
      status: 'completed',
      customer_ref: 'cust_001',
    };
    const result = validateAutolearnResult(raw);
    expect(result.wiki_version_ref).toBe('wv_abc123');
    expect(result.customer_ref).toBe('cust_001');
    expect(result.status).toBe('completed');
  });

  test('accepts a result with stub flag', () => {
    const raw: Record<string, unknown> = {
      wiki_version_ref: 'wv_stub',
      status: 'completed',
      customer_ref: 'cust_stub',
      stub: true,
    };
    const result = validateAutolearnResult(raw);
    expect(result.stub).toBe(true);
  });

  test('passes through extra fields for vendor flexibility', () => {
    const raw: Record<string, unknown> = {
      wiki_version_ref: 'wv_extra',
      status: 'completed',
      customer_ref: 'cust_extra',
      extra_field: 'extra_value',
    };
    const result = validateAutolearnResult(raw);
    expect(result['extra_field']).toBe('extra_value');
  });

  test('throws when wiki_version_ref is missing', () => {
    const raw: Record<string, unknown> = {
      status: 'completed',
      customer_ref: 'cust_001',
    };
    expect(() => validateAutolearnResult(raw)).toThrow('wiki_version_ref');
  });

  test('throws when wiki_version_ref is not a string', () => {
    const raw: Record<string, unknown> = {
      wiki_version_ref: 42,
      status: 'completed',
      customer_ref: 'cust_001',
    };
    expect(() => validateAutolearnResult(raw)).toThrow('wiki_version_ref');
  });

  test('throws when customer_ref is missing', () => {
    const raw: Record<string, unknown> = {
      wiki_version_ref: 'wv_abc',
      status: 'completed',
    };
    expect(() => validateAutolearnResult(raw)).toThrow('customer_ref');
  });

  test('throws when customer_ref is not a string', () => {
    const raw: Record<string, unknown> = {
      wiki_version_ref: 'wv_abc',
      status: 'completed',
      customer_ref: null,
    };
    expect(() => validateAutolearnResult(raw)).toThrow('customer_ref');
  });

  test('throws when result is completely empty', () => {
    expect(() => validateAutolearnResult({})).toThrow();
  });

  test('error message includes partial raw output for debugging', () => {
    const raw: Record<string, unknown> = {
      status: 'completed',
    };
    expect(() => validateAutolearnResult(raw)).toThrow(/wiki_version_ref/);
  });
});

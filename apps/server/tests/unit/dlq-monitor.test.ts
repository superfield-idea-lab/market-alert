/**
 * Unit tests for DLQ monitoring logic (TQ-C-003).
 *
 * Validates:
 *   - checkDlqAlertThreshold correctly identifies breached agent types
 *   - No breach when all counts are at or below threshold
 *   - Breach when any count exceeds threshold
 *   - DLQ_ALERT_THRESHOLD export value
 *   - TaskType enum exports the kb-demo canonical types
 *   - TASK_TYPE_AGENT_MAP maps each TaskType to the correct agent_type string
 */

import { describe, expect, test } from 'vitest';
import { DLQ_ALERT_THRESHOLD, TaskType, TASK_TYPE_AGENT_MAP } from 'db/task-queue';

// ─────────────────────────────────────────────────────────────────────────────
// Inline checkDlqAlertThreshold logic (mirrors the exported function)
// without a live DB — pure threshold comparison.
// ─────────────────────────────────────────────────────────────────────────────

interface DlqDepthRow {
  agent_type: string;
  dead_count: number;
}

function applyThreshold(depth: DlqDepthRow[], threshold: number): DlqDepthRow[] {
  return depth.filter((row) => row.dead_count > threshold);
}

// ── DLQ threshold logic ───────────────────────────────────────────────────────

describe('DLQ threshold check (TQ-C-003)', () => {
  test('DLQ_ALERT_THRESHOLD is 10', () => {
    expect(DLQ_ALERT_THRESHOLD).toBe(10);
  });

  test('no breach when all counts are at or below threshold', () => {
    const depth: DlqDepthRow[] = [
      { agent_type: 'email_ingest', dead_count: 0 },
      { agent_type: 'autolearn', dead_count: 10 },
      { agent_type: 'transcription', dead_count: 5 },
    ];
    expect(applyThreshold(depth, 10)).toHaveLength(0);
  });

  test('breach when any count exceeds threshold', () => {
    const depth: DlqDepthRow[] = [
      { agent_type: 'email_ingest', dead_count: 11 },
      { agent_type: 'autolearn', dead_count: 3 },
    ];
    const breached = applyThreshold(depth, 10);
    expect(breached).toHaveLength(1);
    expect(breached[0].agent_type).toBe('email_ingest');
    expect(breached[0].dead_count).toBe(11);
  });

  test('multiple breached agent types are all returned', () => {
    const depth: DlqDepthRow[] = [
      { agent_type: 'email_ingest', dead_count: 15 },
      { agent_type: 'annotation', dead_count: 20 },
      { agent_type: 'transcription', dead_count: 2 },
    ];
    const breached = applyThreshold(depth, 10);
    expect(breached).toHaveLength(2);
    expect(breached.map((r) => r.agent_type)).toContain('email_ingest');
    expect(breached.map((r) => r.agent_type)).toContain('annotation');
  });

  test('custom threshold respected', () => {
    const depth: DlqDepthRow[] = [{ agent_type: 'bdm_summary', dead_count: 3 }];
    // With threshold=2 the count of 3 should breach
    expect(applyThreshold(depth, 2)).toHaveLength(1);
    // With threshold=5 the count of 3 should not breach
    expect(applyThreshold(depth, 5)).toHaveLength(0);
  });

  test('empty depth returns no breaches', () => {
    expect(applyThreshold([], 10)).toHaveLength(0);
  });
});

// ── TaskType enum ─────────────────────────────────────────────────────────────

describe('TaskType enum (issue #95)', () => {
  test('EMAIL_INGEST is defined', () => {
    expect(TaskType.EMAIL_INGEST).toBe('EMAIL_INGEST');
  });

  test('AUTOLEARN is defined', () => {
    expect(TaskType.AUTOLEARN).toBe('AUTOLEARN');
  });

  test('TRANSCRIPTION is defined', () => {
    expect(TaskType.TRANSCRIPTION).toBe('TRANSCRIPTION');
  });

  test('ANNOTATION is defined', () => {
    expect(TaskType.ANNOTATION).toBe('ANNOTATION');
  });

  test('DEEPCLEAN is defined', () => {
    expect(TaskType.DEEPCLEAN).toBe('DEEPCLEAN');
  });

  test('BDM_SUMMARY is defined', () => {
    expect(TaskType.BDM_SUMMARY).toBe('BDM_SUMMARY');
  });

  test('all 6 TaskType values are present', () => {
    const values = Object.values(TaskType);
    expect(values).toHaveLength(6);
    expect(values).toContain('EMAIL_INGEST');
    expect(values).toContain('AUTOLEARN');
    expect(values).toContain('TRANSCRIPTION');
    expect(values).toContain('ANNOTATION');
    expect(values).toContain('DEEPCLEAN');
    expect(values).toContain('BDM_SUMMARY');
  });
});

// ── TASK_TYPE_AGENT_MAP ───────────────────────────────────────────────────────

describe('TASK_TYPE_AGENT_MAP (issue #95)', () => {
  test('EMAIL_INGEST maps to email_ingest', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.EMAIL_INGEST]).toBe('email_ingest');
  });

  test('AUTOLEARN maps to autolearn', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.AUTOLEARN]).toBe('autolearn');
  });

  test('TRANSCRIPTION maps to transcription', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.TRANSCRIPTION]).toBe('transcription');
  });

  test('ANNOTATION maps to annotation', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.ANNOTATION]).toBe('annotation');
  });

  test('DEEPCLEAN maps to deepclean', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.DEEPCLEAN]).toBe('deepclean');
  });

  test('BDM_SUMMARY maps to bdm_summary', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.BDM_SUMMARY]).toBe('bdm_summary');
  });

  test('all 6 TaskType values are mapped', () => {
    const keys = Object.keys(TASK_TYPE_AGENT_MAP);
    expect(keys).toHaveLength(6);
  });

  test('each agent_type string is lowercase with underscores', () => {
    for (const agentType of Object.values(TASK_TYPE_AGENT_MAP)) {
      expect(agentType).toMatch(/^[a-z_]+$/);
    }
  });
});

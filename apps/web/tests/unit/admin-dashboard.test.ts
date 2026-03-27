/**
 * Unit tests for admin dashboard rendering logic, access control,
 * WebSocket reactive task queue update logic, findings tab summary logic,
 * and severity badge resolution — all without requiring DOM rendering.
 */

import { describe, test, expect } from 'vitest';

/**
 * Mirror of the nav visibility decision: the admin button should only
 * appear when the user has isSuperadmin === true.
 */
function isAdminNavVisible(isSuperadmin: boolean | undefined): boolean {
  return isSuperadmin === true;
}

/**
 * Mirror of the admin view access guard: the admin dashboard should
 * only render when the user has isSuperadmin === true.
 */
function resolveAdminViewBranch(
  activeView: string,
  isSuperadmin: boolean | undefined,
): 'dashboard' | 'denied' | 'other' {
  if (activeView !== 'admin') return 'other';
  if (isSuperadmin === true) return 'dashboard';
  return 'denied';
}

/**
 * Mirror of status badge colour resolution.
 */
function resolveStatusColor(status: string): string {
  const STATUS_COLORS: Record<string, string> = {
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    claimed: 'bg-blue-50 text-blue-700 border-blue-200',
    running: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    submitting: 'bg-purple-50 text-purple-700 border-purple-200',
    completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
    dead: 'bg-zinc-100 text-zinc-500 border-zinc-300',
  };
  return STATUS_COLORS[status] ?? 'bg-zinc-50 text-zinc-600 border-zinc-200';
}

// ---------------------------------------------------------------------------
// Mirror of the task list reactive merge logic from AdminDashboard
// ---------------------------------------------------------------------------

interface TaskEntry {
  id: string;
  status: string;
  agent_type: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

/**
 * Applies a task_queue WebSocket event to a task list.
 * Mirrors the `applyTaskEvent` logic in AdminDashboard.
 */
function applyTaskEvent(
  prev: TaskEntry[],
  event: string,
  data: Record<string, unknown>,
): TaskEntry[] {
  const incoming = data as unknown as TaskEntry;
  if (event === 'task_queue.created') {
    if (prev.some((t) => t.id === incoming.id)) return prev;
    return [incoming, ...prev].slice(0, 50);
  }
  if (event === 'task_queue.updated') {
    const idx = prev.findIndex((t) => t.id === incoming.id);
    if (idx === -1) {
      return [incoming, ...prev].slice(0, 50);
    }
    const next = [...prev];
    next[idx] = { ...next[idx], ...incoming };
    return next;
  }
  return prev;
}

// ---------------------------------------------------------------------------
// Findings tab logic
// ---------------------------------------------------------------------------

type FindingsSummary = Record<string, Record<string, number>>;

/**
 * Mirror of findings summary aggregation: total counts by severity from all agent
 * types' counts.
 */
function computeTotalBySeverity(summary: FindingsSummary): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const agentCounts of Object.values(summary)) {
    for (const [sev, count] of Object.entries(agentCounts)) {
      totals[sev] = (totals[sev] ?? 0) + count;
    }
  }
  return totals;
}

/**
 * Mirror of severity badge colour resolution.
 */
function resolveSeverityColor(severity: string): string {
  const SEVERITY_COLORS: Record<string, string> = {
    critical: 'bg-red-100 text-red-800 border-red-300',
    high: 'bg-orange-50 text-orange-700 border-orange-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    low: 'bg-yellow-50 text-yellow-600 border-yellow-200',
    info: 'bg-blue-50 text-blue-600 border-blue-200',
    unknown: 'bg-zinc-50 text-zinc-500 border-zinc-200',
  };
  return SEVERITY_COLORS[severity.toLowerCase()] ?? 'bg-zinc-50 text-zinc-500 border-zinc-200';
}

/**
 * Mirror of grouping findings by agent type.
 */
interface Finding {
  task_id: string;
  agent_type: string;
  severity: string;
  file_path: string;
  description: string;
  remediation: string;
  scanned_at: string;
}

function groupFindingsByAgentType(findings: Finding[]): Record<string, Finding[]> {
  const groups: Record<string, Finding[]> = {};
  for (const f of findings) {
    if (!groups[f.agent_type]) groups[f.agent_type] = [];
    groups[f.agent_type].push(f);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Admin nav visibility', () => {
  test('visible when isSuperadmin is true', () => {
    expect(isAdminNavVisible(true)).toBe(true);
  });

  test('hidden when isSuperadmin is false', () => {
    expect(isAdminNavVisible(false)).toBe(false);
  });

  test('hidden when isSuperadmin is undefined', () => {
    expect(isAdminNavVisible(undefined)).toBe(false);
  });
});

describe('Admin view access guard', () => {
  test('shows dashboard for superadmin on admin view', () => {
    expect(resolveAdminViewBranch('admin', true)).toBe('dashboard');
  });

  test('shows denied for non-superadmin on admin view', () => {
    expect(resolveAdminViewBranch('admin', false)).toBe('denied');
  });

  test('shows denied for undefined superadmin on admin view', () => {
    expect(resolveAdminViewBranch('admin', undefined)).toBe('denied');
  });

  test('returns other for non-admin views', () => {
    expect(resolveAdminViewBranch('board', true)).toBe('other');
    expect(resolveAdminViewBranch('settings', false)).toBe('other');
    expect(resolveAdminViewBranch('pwa', undefined)).toBe('other');
  });
});

describe('Task queue status badge colours', () => {
  test('returns correct colour for each known status', () => {
    expect(resolveStatusColor('pending')).toContain('amber');
    expect(resolveStatusColor('claimed')).toContain('blue');
    expect(resolveStatusColor('running')).toContain('indigo');
    expect(resolveStatusColor('submitting')).toContain('purple');
    expect(resolveStatusColor('completed')).toContain('emerald');
    expect(resolveStatusColor('failed')).toContain('red');
    expect(resolveStatusColor('dead')).toContain('zinc');
  });

  test('returns fallback colour for unknown status', () => {
    expect(resolveStatusColor('unknown')).toBe('bg-zinc-50 text-zinc-600 border-zinc-200');
  });
});

describe('AdminDashboard module exports', () => {
  test('AdminDashboard is exported from the module', async () => {
    const mod = await import('../../src/pages/admin-dashboard.js');
    expect(typeof mod.AdminDashboard).toBe('function');
  });
});

describe('Task queue reactive merge logic (applyTaskEvent)', () => {
  const baseTask: TaskEntry = {
    id: 'task-1',
    status: 'pending',
    agent_type: 'coding',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    claimed_at: null,
    completed_at: null,
  };

  test('task_queue.created prepends a new task to the list', () => {
    const result = applyTaskEvent(
      [],
      'task_queue.created',
      baseTask as unknown as Record<string, unknown>,
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('task-1');
  });

  test('task_queue.created is idempotent for duplicate ids', () => {
    const result = applyTaskEvent(
      [baseTask],
      'task_queue.created',
      baseTask as unknown as Record<string, unknown>,
    );
    expect(result).toHaveLength(1);
  });

  test('task_queue.updated merges status change into existing row', () => {
    const update = { ...baseTask, status: 'running', updated_at: '2026-01-01T00:01:00Z' };
    const result = applyTaskEvent(
      [baseTask],
      'task_queue.updated',
      update as unknown as Record<string, unknown>,
    );
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('running');
    expect(result[0].updated_at).toBe('2026-01-01T00:01:00Z');
  });

  test('task_queue.updated adds row if id is not in list', () => {
    const newTask = { ...baseTask, id: 'task-2', status: 'claimed' };
    const result = applyTaskEvent(
      [baseTask],
      'task_queue.updated',
      newTask as unknown as Record<string, unknown>,
    );
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('task-2');
  });

  test('unknown event type returns list unchanged', () => {
    const result = applyTaskEvent(
      [baseTask],
      'task.updated',
      baseTask as unknown as Record<string, unknown>,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(baseTask);
  });

  test('list is capped at 50 entries on created', () => {
    const big: TaskEntry[] = Array.from({ length: 50 }, (_, i) => ({
      ...baseTask,
      id: `task-${i}`,
    }));
    const newTask = { ...baseTask, id: 'task-new' };
    const result = applyTaskEvent(
      big,
      'task_queue.created',
      newTask as unknown as Record<string, unknown>,
    );
    expect(result).toHaveLength(50);
    expect(result[0].id).toBe('task-new');
  });
});

describe('Findings summary aggregation', () => {
  test('aggregates counts by severity across agent types', () => {
    const summary: FindingsSummary = {
      security: { critical: 2, high: 3 },
      soc_compliance: { high: 1, medium: 4 },
      runtime_errors: { low: 2 },
      code_cleanup: {},
    };
    const totals = computeTotalBySeverity(summary);
    expect(totals.critical).toBe(2);
    expect(totals.high).toBe(4);
    expect(totals.medium).toBe(4);
    expect(totals.low).toBe(2);
  });

  test('returns empty object for empty summary', () => {
    expect(computeTotalBySeverity({})).toEqual({});
  });

  test('handles agent type with no findings', () => {
    const summary: FindingsSummary = {
      security: {},
      code_cleanup: { info: 5 },
    };
    const totals = computeTotalBySeverity(summary);
    expect(totals.info).toBe(5);
    expect(totals.critical).toBeUndefined();
  });
});

describe('Severity badge colour resolution', () => {
  test('returns correct colour for each known severity', () => {
    expect(resolveSeverityColor('critical')).toContain('red');
    expect(resolveSeverityColor('high')).toContain('orange');
    expect(resolveSeverityColor('medium')).toContain('amber');
    expect(resolveSeverityColor('low')).toContain('yellow');
    expect(resolveSeverityColor('info')).toContain('blue');
    expect(resolveSeverityColor('unknown')).toContain('zinc');
  });

  test('returns fallback colour for unrecognised severity', () => {
    expect(resolveSeverityColor('warning')).toBe('bg-zinc-50 text-zinc-500 border-zinc-200');
  });

  test('is case-insensitive', () => {
    expect(resolveSeverityColor('CRITICAL')).toContain('red');
    expect(resolveSeverityColor('High')).toContain('orange');
  });
});

describe('Findings grouping by agent type', () => {
  const sampleFindings: Finding[] = [
    {
      task_id: 'task-1',
      agent_type: 'security',
      severity: 'high',
      file_path: 'src/auth.ts',
      description: 'SQL injection risk',
      remediation: 'Use parameterised queries',
      scanned_at: '2026-03-27T10:00:00Z',
    },
    {
      task_id: 'task-1',
      agent_type: 'security',
      severity: 'medium',
      file_path: 'src/api/users.ts',
      description: 'Missing rate limit',
      remediation: 'Add rate limiting middleware',
      scanned_at: '2026-03-27T10:00:00Z',
    },
    {
      task_id: 'task-2',
      agent_type: 'code_cleanup',
      severity: 'low',
      file_path: 'src/utils.ts',
      description: 'Unused import',
      remediation: 'Remove unused import',
      scanned_at: '2026-03-27T11:00:00Z',
    },
  ];

  test('groups findings by agent type', () => {
    const groups = groupFindingsByAgentType(sampleFindings);
    expect(groups['security']).toHaveLength(2);
    expect(groups['code_cleanup']).toHaveLength(1);
  });

  test('groups preserve agent_type for each finding', () => {
    const groups = groupFindingsByAgentType(sampleFindings);
    for (const f of groups['security']) {
      expect(f.agent_type).toBe('security');
    }
  });

  test('returns empty object for empty findings array', () => {
    expect(groupFindingsByAgentType([])).toEqual({});
  });
});

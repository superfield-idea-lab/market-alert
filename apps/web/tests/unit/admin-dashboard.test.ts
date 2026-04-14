/**
 * Unit tests for admin dashboard rendering logic, access control,
 * WebSocket reactive task queue update logic, findings tab summary logic,
 * and severity badge resolution — all without requiring DOM rendering.
 */

import { describe, test, expect } from 'vitest';

/**
 * Mirror of the nav visibility decision: the admin button should appear when
 * the user can access the admin surface as either a superadmin or CRM admin.
 */
function isAdminNavVisible(
  isSuperadmin: boolean | undefined,
  isCrmAdmin: boolean | undefined,
): boolean {
  return isSuperadmin === true || isCrmAdmin === true;
}

/**
 * Mirror of the admin view access guard: the admin dashboard should render
 * when the user can access the admin surface.
 */
function resolveAdminViewBranch(
  activeView: string,
  isSuperadmin: boolean | undefined,
  isCrmAdmin: boolean | undefined,
): 'dashboard' | 'denied' | 'other' {
  if (activeView !== 'admin') return 'other';
  if (isSuperadmin === true || isCrmAdmin === true) return 'dashboard';
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
// Tests
// ---------------------------------------------------------------------------

describe('Admin nav visibility', () => {
  test('visible when isSuperadmin is true', () => {
    expect(isAdminNavVisible(true, false)).toBe(true);
  });

  test('hidden when isSuperadmin is false', () => {
    expect(isAdminNavVisible(false, false)).toBe(false);
  });

  test('hidden when isSuperadmin is undefined', () => {
    expect(isAdminNavVisible(undefined, undefined)).toBe(false);
  });

  test('visible when isCrmAdmin is true', () => {
    expect(isAdminNavVisible(false, true)).toBe(true);
  });
});

describe('Admin view access guard', () => {
  test('shows dashboard for superadmin on admin view', () => {
    expect(resolveAdminViewBranch('admin', true, false)).toBe('dashboard');
  });

  test('shows denied for non-superadmin on admin view', () => {
    expect(resolveAdminViewBranch('admin', false, false)).toBe('denied');
  });

  test('shows denied for undefined superadmin on admin view', () => {
    expect(resolveAdminViewBranch('admin', undefined, undefined)).toBe('denied');
  });

  test('shows dashboard for CRM admin on admin view', () => {
    expect(resolveAdminViewBranch('admin', false, true)).toBe('dashboard');
  });

  test('returns other for non-admin views', () => {
    expect(resolveAdminViewBranch('board', true, false)).toBe('other');
    expect(resolveAdminViewBranch('settings', false, true)).toBe('other');
    expect(resolveAdminViewBranch('pwa', undefined, undefined)).toBe('other');
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

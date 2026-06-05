/**
 * @file agent-task-queue.tsx
 *
 * Superadmin-only Agent Queue live view (issue #115).
 *
 * Displays the task_queue table grouped by agent_type. Each row shows
 * id, job_type, status badge, attempt count, and created_at timestamp.
 * Real-time updates arrive via the task_queue_admin WebSocket channel.
 *
 * Status badge colours:
 *   - completed      → green
 *   - failed / dead  → red
 *   - pending        → grey
 *   - claimed / running / submitting → yellow
 *
 * No third-party data-grid or table library is used — DIY controlled state.
 *
 * ## Canonical docs
 * - docs/prd.md — superadmin task queue monitoring
 *
 * @see apps/web/src/hooks/use-task-queue-feed.ts — data hook
 * @see https://github.com/superfield-idea-lab/market-alert/issues/115
 */

import React from 'react';
import {
  useTaskQueueFeed,
  type TaskQueueStatus,
  type TaskQueueRow,
} from '../hooks/use-task-queue-feed';

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

interface BadgeProps {
  status: TaskQueueStatus;
}

function statusBadgeClass(status: TaskQueueStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'failed':
    case 'dead':
      return 'bg-red-100 text-red-800 border-red-200';
    case 'pending':
      return 'bg-zinc-100 text-zinc-600 border-zinc-200';
    case 'claimed':
    case 'running':
    case 'submitting':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    default:
      return 'bg-zinc-100 text-zinc-600 border-zinc-200';
  }
}

function StatusBadge({ status }: BadgeProps): React.ReactElement {
  return (
    <span
      data-testid={`status-badge-${status}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadgeClass(status)}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

interface TaskRowProps {
  task: TaskQueueRow;
}

function TaskRow({ task }: TaskRowProps): React.ReactElement {
  const createdAt = new Date(task.created_at).toLocaleString();
  return (
    <tr
      data-testid={`task-row-${task.id}`}
      className="border-b border-zinc-100 hover:bg-zinc-50 transition-colors"
    >
      <td className="px-4 py-2 text-xs font-mono text-zinc-500 max-w-xs truncate" title={task.id}>
        {task.id}
      </td>
      <td className="px-4 py-2 text-sm text-zinc-700">{task.job_type}</td>
      <td className="px-4 py-2">
        <StatusBadge status={task.status} />
      </td>
      <td className="px-4 py-2 text-sm text-zinc-600 text-right tabular-nums">{task.attempt}</td>
      <td className="px-4 py-2 text-xs text-zinc-500 whitespace-nowrap">{createdAt}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Agent group
// ---------------------------------------------------------------------------

interface AgentGroupProps {
  agentType: string;
  tasks: TaskQueueRow[];
}

function AgentGroup({ agentType, tasks }: AgentGroupProps): React.ReactElement {
  return (
    <section className="mb-8" aria-label={`Agent group: ${agentType}`}>
      <h2 className="text-sm font-semibold text-zinc-700 mb-2 px-1 uppercase tracking-wide">
        {agentType}
        <span className="ml-2 text-xs font-normal text-zinc-400 normal-case tracking-normal">
          ({tasks.length} task{tasks.length !== 1 ? 's' : ''})
        </span>
      </h2>
      <div className="overflow-x-auto rounded-lg border border-zinc-200">
        <table className="min-w-full text-left">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-200">
              <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                ID
              </th>
              <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                Job type
              </th>
              <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                Status
              </th>
              <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wide text-right">
                Attempts
              </th>
              <th className="px-4 py-2 text-xs font-medium text-zinc-500 uppercase tracking-wide">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * AgentTaskQueuePage — superadmin-only live view of the task_queue table.
 *
 * Groups tasks by agent_type. Real-time updates arrive via WebSocket.
 * No third-party table library — DIY controlled state via useTaskQueueFeed.
 */
export function AgentTaskQueuePage(): React.ReactElement {
  const { tasks, status, error } = useTaskQueueFeed();

  // Group tasks by agent_type, preserving order of first appearance
  const groups = tasks.reduce<Map<string, TaskQueueRow[]>>((acc, task) => {
    const list = acc.get(task.agent_type) ?? [];
    list.push(task);
    acc.set(task.agent_type, list);
    return acc;
  }, new Map());

  const connectionLabel: Record<typeof status, string> = {
    idle: 'Initialising',
    loading: 'Loading…',
    connecting: 'Connecting…',
    connected: 'Live',
    disconnected: 'Reconnecting…',
    error: 'Error',
  };

  const connectionDotClass: Record<typeof status, string> = {
    idle: 'bg-zinc-400',
    loading: 'bg-zinc-400',
    connecting: 'bg-yellow-400',
    connected: 'bg-green-500',
    disconnected: 'bg-yellow-400 animate-pulse',
    error: 'bg-red-500',
  };

  return (
    <main aria-label="Agent task queue" className="p-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Agent Queue</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Real-time view of the task_queue for all agents. Superadmin only.
          </p>
        </div>
        <div
          className="flex items-center gap-2 text-sm text-zinc-500"
          data-testid="connection-status"
          aria-label={`Connection status: ${connectionLabel[status]}`}
        >
          <span className={`w-2 h-2 rounded-full ${connectionDotClass[status]}`} />
          {connectionLabel[status]}
        </div>
      </div>

      {status === 'loading' && (
        <div className="flex items-center justify-center py-16 text-zinc-400">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-zinc-400 mr-3" />
          Loading task queue…
        </div>
      )}

      {status === 'error' && (
        <div
          data-testid="feed-error"
          className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          {error ?? 'Failed to load task queue.'}
        </div>
      )}

      {status !== 'loading' && status !== 'error' && groups.size === 0 && (
        <div
          data-testid="empty-queue"
          className="rounded-lg border border-zinc-200 bg-zinc-50 p-8 text-center text-sm text-zinc-400"
        >
          No tasks in the queue.
        </div>
      )}

      {groups.size > 0 && (
        <div data-testid="task-groups">
          {Array.from(groups.entries()).map(([agentType, agentTasks]) => (
            <AgentGroup key={agentType} agentType={agentType} tasks={agentTasks} />
          ))}
        </div>
      )}
    </main>
  );
}

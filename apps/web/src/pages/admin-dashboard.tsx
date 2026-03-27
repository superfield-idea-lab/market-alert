import React, { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskQueueEntry {
  id: string;
  status: string;
  agent_type: string | null;
  job_type?: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

interface AdminUser {
  id: string;
  properties: {
    username?: string;
    role?: string;
    active?: boolean;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Status badge colour map
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  claimed: 'bg-blue-50 text-blue-700 border-blue-200',
  running: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  submitting: 'bg-purple-50 text-purple-700 border-purple-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
  dead: 'bg-zinc-100 text-zinc-500 border-zinc-300',
};

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? 'bg-zinc-50 text-zinc-600 border-zinc-200';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${colors}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Build the WebSocket URL from the current page origin. */
function buildWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/** WebSocket reconnect base delay in milliseconds. */
const WS_RECONNECT_BASE_MS = 1_000;
/** Maximum reconnect delay in milliseconds (exponential back-off cap). */
const WS_RECONNECT_MAX_MS = 30_000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminDashboard() {
  const [tasks, setTasks] = useState<TaskQueueEntry[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(WS_RECONNECT_BASE_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/task-queue?limit=50', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks ?? []);
      }
    } catch (err) {
      console.error('Admin dashboard task fetch error:', err);
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/users?limit=50', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users ?? []);
      }
    } catch (err) {
      console.error('Admin dashboard user fetch error:', err);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  const fetchData = useCallback(() => {
    fetchTasks();
    fetchUsers();
  }, [fetchTasks, fetchUsers]);

  /** Apply an incoming task_queue WebSocket event to the task list. */
  const applyTaskEvent = useCallback((event: string, data: Record<string, unknown>) => {
    if (event === 'task_queue.created') {
      const incoming = data as unknown as TaskQueueEntry;
      setTasks((prev) => {
        // Avoid duplicates — prepend if not already present.
        if (prev.some((t) => t.id === incoming.id)) return prev;
        return [incoming, ...prev].slice(0, 50);
      });
    } else if (event === 'task_queue.updated') {
      const incoming = data as unknown as TaskQueueEntry;
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === incoming.id);
        if (idx === -1) {
          // Row not yet in the list — add it at the top.
          return [incoming, ...prev].slice(0, 50);
        }
        const next = [...prev];
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
    }
  }, []);

  /** Connect (or reconnect) the WebSocket. */
  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(buildWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) {
        ws.close();
        return;
      }
      setWsConnected(true);
      reconnectDelayRef.current = WS_RECONNECT_BASE_MS;
      // Re-fetch tasks on reconnect to sync any changes missed during disconnect.
      fetchTasks();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          event: string;
          data: Record<string, unknown>;
        };
        if (typeof msg.event === 'string' && msg.event.startsWith('task_queue.')) {
          applyTaskEvent(msg.event, msg.data ?? {});
        }
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setWsConnected(false);
      // Exponential back-off reconnect.
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, WS_RECONNECT_MAX_MS);
      reconnectTimerRef.current = setTimeout(connectWs, delay);
    };

    ws.onerror = () => {
      // onclose fires after onerror; reconnect logic runs there.
    };
  }, [applyTaskEvent, fetchTasks]);

  // Initial data load + WebSocket connection on mount.
  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    connectWs();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Admin Dashboard</h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            {wsConnected ? (
              <span className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Live
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-300" />
                Reconnecting…
              </span>
            )}
          </p>
        </div>
        <button
          onClick={fetchData}
          className="px-3 py-1.5 text-xs font-medium text-zinc-600 border border-zinc-200 rounded-lg hover:bg-zinc-50 transition-colors flex items-center gap-1.5"
          title="Refresh now"
        >
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      {/* Task Queue Panel */}
      <section>
        <h2 className="text-sm font-semibold text-zinc-700 mb-3 uppercase tracking-wide">
          Task Queue
        </h2>
        <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
          {loadingTasks ? (
            <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
              Loading task queue...
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
              No task queue entries found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    <th className="px-4 py-3">ID</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Agent Type</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-zinc-50 hover:bg-zinc-50 transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                        {t.id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{t.agent_type ?? '--'}</td>
                      <td className="px-4 py-3 text-zinc-400 tabular-nums text-xs">
                        {formatTimestamp(t.created_at)}
                      </td>
                      <td className="px-4 py-3 text-zinc-400 tabular-nums text-xs">
                        {formatTimestamp(t.updated_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* User List Panel */}
      <section>
        <h2 className="text-sm font-semibold text-zinc-700 mb-3 uppercase tracking-wide">Users</h2>
        <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
          {loadingUsers ? (
            <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
              Loading users...
            </div>
          ) : users.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
              No users found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-zinc-100 text-left text-xs font-semibold uppercase tracking-wide text-zinc-400">
                    <th className="px-4 py-3">Username</th>
                    <th className="px-4 py-3">Role</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-zinc-50 hover:bg-zinc-50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-zinc-900">
                        {(u.properties.username as string) ?? u.id.slice(0, 8)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium border capitalize bg-zinc-50 text-zinc-600 border-zinc-200">
                          {(u.properties.role as string) ?? 'user'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {u.properties.active === false ? (
                          <span className="text-xs text-red-500 font-medium">Inactive</span>
                        ) : (
                          <span className="text-xs text-emerald-600 font-medium">Active</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-400 tabular-nums text-xs">
                        {formatTimestamp(u.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

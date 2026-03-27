import React, { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';

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

interface Finding {
  task_id: string;
  agent_type: string;
  severity: string;
  file_path: string;
  description: string;
  remediation: string;
  scanned_at: string;
}

type FindingsSummary = Record<string, Record<string, number>>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Display names for self-improving agent types. */
const AGENT_TYPE_LABELS: Record<string, string> = {
  security: 'Security',
  soc_compliance: 'SOC Compliance',
  runtime_errors: 'Runtime Errors',
  code_cleanup: 'Code Cleanup',
};

/** Ordered list of known agent types shown in the dashboard. */
const AGENT_TYPES = ['security', 'soc_compliance', 'runtime_errors', 'code_cleanup'];

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
// Severity badge
// ---------------------------------------------------------------------------

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-300',
  high: 'bg-orange-50 text-orange-700 border-orange-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-yellow-50 text-yellow-600 border-yellow-200',
  info: 'bg-blue-50 text-blue-600 border-blue-200',
  unknown: 'bg-zinc-50 text-zinc-500 border-zinc-200',
};

function SeverityBadge({ severity }: { severity: string }) {
  const colors =
    SEVERITY_COLORS[severity.toLowerCase()] ?? 'bg-zinc-50 text-zinc-500 border-zinc-200';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border uppercase tracking-wide ${colors}`}
    >
      {severity}
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
// Findings summary bar
// ---------------------------------------------------------------------------

function FindingsSummaryBar({ summary }: { summary: FindingsSummary }) {
  const totalBySeverity: Record<string, number> = {};
  for (const agentCounts of Object.values(summary)) {
    for (const [sev, count] of Object.entries(agentCounts)) {
      totalBySeverity[sev] = (totalBySeverity[sev] ?? 0) + count;
    }
  }

  const severityOrder = ['critical', 'high', 'medium', 'low', 'info', 'unknown'];
  const sortedEntries = severityOrder
    .filter((s) => totalBySeverity[s] !== undefined)
    .map((s) => [s, totalBySeverity[s]] as [string, number]);

  // Include any unknown severities not in the predefined order
  for (const [sev, count] of Object.entries(totalBySeverity)) {
    if (!severityOrder.includes(sev)) {
      sortedEntries.push([sev, count]);
    }
  }

  if (sortedEntries.length === 0) {
    return <p className="text-xs text-zinc-400 italic">No findings available for summary.</p>;
  }

  return (
    <div className="flex flex-wrap gap-3">
      {sortedEntries.map(([sev, count]) => (
        <div
          key={sev}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${
            SEVERITY_COLORS[sev.toLowerCase()] ?? 'bg-zinc-50 text-zinc-500 border-zinc-200'
          }`}
        >
          <span className="font-bold text-sm">{count}</span>
          <span className="capitalize">{sev}</span>
        </div>
      ))}
      {AGENT_TYPES.filter((at) => summary[at]).map((at) => {
        const total = Object.values(summary[at]).reduce((a, b) => a + b, 0);
        return (
          <div
            key={at}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium bg-zinc-50 text-zinc-600 border-zinc-200"
          >
            <span className="font-bold text-sm">{total}</span>
            <span>{AGENT_TYPE_LABELS[at] ?? at}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent findings section (collapsible)
// ---------------------------------------------------------------------------

function AgentFindingsSection({ agentType, findings }: { agentType: string; findings: Finding[] }) {
  const [expanded, setExpanded] = useState(true);
  const label = AGENT_TYPE_LABELS[agentType] ?? agentType;

  return (
    <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
      {/* Section header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-50 hover:bg-zinc-100 transition-colors text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown size={14} className="text-zinc-400 shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-zinc-400 shrink-0" />
          )}
          <span className="text-sm font-semibold text-zinc-800">{label}</span>
          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-zinc-200 text-zinc-600">
            {findings.length}
          </span>
        </div>
      </button>

      {expanded && (
        <div>
          {findings.length === 0 ? (
            <div className="flex items-center justify-center h-16 text-zinc-400 text-sm italic">
              No findings for this agent type.
            </div>
          ) : (
            <div className="divide-y divide-zinc-50">
              {findings.map((f, idx) => (
                <div
                  key={`${f.task_id}-${idx}`}
                  className="px-4 py-3 hover:bg-zinc-50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 mt-0.5">
                      <SeverityBadge severity={f.severity} />
                    </div>
                    <div className="flex-1 min-w-0">
                      {f.file_path && (
                        <p className="font-mono text-xs text-zinc-500 mb-1 truncate">
                          {f.file_path}
                        </p>
                      )}
                      <p className="text-sm text-zinc-800 mb-1">{f.description || '--'}</p>
                      {f.remediation && (
                        <p className="text-xs text-zinc-500 italic">
                          <span className="font-semibold not-italic text-zinc-600">
                            Remediation:
                          </span>{' '}
                          {f.remediation}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-xs text-zinc-400 tabular-nums whitespace-nowrap">
                      {formatTimestamp(f.scanned_at)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Findings tab
// ---------------------------------------------------------------------------

function FindingsTab() {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [summary, setSummary] = useState<FindingsSummary>({});
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchFindings = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/findings?limit=200', { credentials: 'include' });
      if (res.ok) {
        const data = (await res.json()) as { findings: Finding[]; summary: FindingsSummary };
        setFindings(data.findings ?? []);
        setSummary(data.summary ?? {});
        setLastRefresh(new Date());
      }
    } catch (err) {
      console.error('Findings fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchFindings();
  }, [fetchFindings]);

  // Reactive WebSocket updates — refresh when a task completes
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    let ws: WebSocket;

    function connect() {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as { event: string; data: unknown };
          // Re-fetch findings whenever a task queue entry is updated (may have new results)
          if (msg.event === 'task.updated' || msg.event === 'task.created') {
            fetchFindings();
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        // Reconnect after 3 seconds on unexpected close
        setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      ws?.close();
    };
  }, [fetchFindings]);

  // Group findings by agent type
  const findingsByAgent: Record<string, Finding[]> = {};
  for (const at of AGENT_TYPES) {
    findingsByAgent[at] = [];
  }
  for (const f of findings) {
    if (!findingsByAgent[f.agent_type]) {
      findingsByAgent[f.agent_type] = [];
    }
    findingsByAgent[f.agent_type].push(f);
  }

  // All agent types that have findings or are in the known list
  const agentTypesInFindings = Array.from(
    new Set([...AGENT_TYPES, ...findings.map((f) => f.agent_type)]),
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
        Loading findings...
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Summary bar */}
      <div className="border border-zinc-200 rounded-xl bg-white px-4 py-3">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
          Summary
        </h3>
        <FindingsSummaryBar summary={summary} />
      </div>

      {findings.length === 0 ? (
        <div className="flex items-center justify-center h-24 text-zinc-400 text-sm italic border border-zinc-200 rounded-xl bg-white">
          No findings yet. Findings appear once self-improving agents complete scans.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {agentTypesInFindings.map((at) => (
            <AgentFindingsSection key={at} agentType={at} findings={findingsByAgent[at] ?? []} />
          ))}
        </div>
      )}

      <p className="text-xs text-zinc-400 text-right">
        {lastRefresh ? `Last refreshed ${lastRefresh.toLocaleTimeString()}` : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type AdminTab = 'tasks' | 'users' | 'findings';

export function AdminDashboard() {
  const [tasks, setTasks] = useState<TaskQueueEntry[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('tasks');

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
  }, []); // intentional: run once on mount; fetchData and connectWs are stable refs

  const tabs: { id: AdminTab; label: string }[] = [
    { id: 'tasks', label: 'Task Queue' },
    { id: 'users', label: 'Users' },
    { id: 'findings', label: 'Findings' },
  ];

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

      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-zinc-200">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? 'border-indigo-500 text-indigo-600'
                : 'border-transparent text-zinc-500 hover:text-zinc-700 hover:border-zinc-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Task Queue Panel */}
      {activeTab === 'tasks' && (
        <section>
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
      )}

      {/* User List Panel */}
      {activeTab === 'users' && (
        <section>
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
      )}

      {/* Findings Tab */}
      {activeTab === 'findings' && <FindingsTab />}
    </div>
  );
}

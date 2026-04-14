import React, { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, Search } from 'lucide-react';

/** Debounce delay for search input (milliseconds). */
const SEARCH_DEBOUNCE_MS = 300;

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
// CRM entity management tab
// ---------------------------------------------------------------------------

type CrmEntityType = 'asset_manager' | 'fund';

interface CrmEntity {
  id: string;
  type: CrmEntityType;
  properties: {
    name?: string;
    notes?: string;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
}

const CRM_TYPE_LABELS: Record<CrmEntityType, string> = {
  asset_manager: 'Asset Managers',
  fund: 'Funds',
};

function CrmEntitiesTab() {
  const [entityType, setEntityType] = useState<CrmEntityType>('asset_manager');
  const [entities, setEntities] = useState<CrmEntity[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { name: string; notes: string }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createType, setCreateType] = useState<CrmEntityType>('asset_manager');
  const [createName, setCreateName] = useState('');
  const [createNotes, setCreateNotes] = useState('');

  const fetchEntities = useCallback(async (type: CrmEntityType) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/crm/entities?type=${type}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to load CRM entities');
      }
      const data = (await res.json()) as { entities?: CrmEntity[] };
      const nextEntities = data.entities ?? [];
      setEntities(nextEntities);
      const nextDrafts: Record<string, { name: string; notes: string }> = {};
      for (const entity of nextEntities) {
        nextDrafts[entity.id] = {
          name: typeof entity.properties.name === 'string' ? entity.properties.name : '',
          notes: typeof entity.properties.notes === 'string' ? entity.properties.notes : '',
        };
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load CRM entities');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntities(entityType);
    setCreateType(entityType);
  }, [entityType, fetchEntities]);

  const updateDraft = (id: string, field: 'name' | 'notes', value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [id]: {
        name: prev[id]?.name ?? '',
        notes: prev[id]?.notes ?? '',
        [field]: value,
      },
    }));
  };

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/admin/crm/entities', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: createType,
          properties: {
            name: createName,
            notes: createNotes,
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to create CRM entity');
      }
      setCreateName('');
      setCreateNotes('');
      setEntityType(createType);
      await fetchEntities(createType);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create CRM entity');
    }
  };

  const handleSave = async (entityId: string) => {
    const draft = drafts[entityId];
    if (!draft) return;
    setError('');
    try {
      const res = await fetch(`/api/admin/crm/entities/${entityId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: {
            name: draft.name,
            notes: draft.notes,
          },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to update CRM entity');
      }
      await fetchEntities(entityType);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update CRM entity');
    }
  };

  const handleDelete = async (entityId: string) => {
    setError('');
    try {
      const res = await fetch(`/api/admin/crm/entities/${entityId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Failed to delete CRM entity');
      }
      await fetchEntities(entityType);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete CRM entity');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide">
            CRM entities
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Manage the asset-manager and fund registry used by campaign analysis.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-1 text-xs font-medium">
          {(Object.keys(CRM_TYPE_LABELS) as CrmEntityType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setEntityType(type)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                entityType === type ? 'bg-indigo-600 text-white' : 'text-zinc-500 hover:bg-zinc-100'
              }`}
            >
              {CRM_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      <form
        onSubmit={handleCreate}
        className="grid gap-3 rounded-xl border border-zinc-200 bg-white p-4 md:grid-cols-[160px_1fr_1fr_auto]"
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
          Type
          <select
            value={createType}
            onChange={(e) => setCreateType(e.target.value as CrmEntityType)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
          >
            <option value="asset_manager">Asset manager</option>
            <option value="fund">Fund</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
          Name
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
            placeholder="E.g. Atlas Capital"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
          Notes
          <input
            value={createNotes}
            onChange={(e) => setCreateNotes(e.target.value)}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
            placeholder="Optional note"
          />
        </label>
        <button
          type="submit"
          className="self-end rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Create
        </button>
      </form>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white">
        {loading ? (
          <div className="flex h-24 items-center justify-center text-sm text-zinc-400">
            Loading {CRM_TYPE_LABELS[entityType].toLowerCase()}...
          </div>
        ) : entities.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-sm text-zinc-400">
            No {CRM_TYPE_LABELS[entityType].toLowerCase()} found.
          </div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {entities.map((entity) => {
              const draft = drafts[entity.id] ?? { name: '', notes: '' };
              return (
                <div key={entity.id} className="grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto]">
                  <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
                    Name
                    <input
                      value={draft.name}
                      onChange={(e) => updateDraft(entity.id, 'name', e.target.value)}
                      className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
                    Notes
                    <input
                      value={draft.notes}
                      onChange={(e) => updateDraft(entity.id, 'notes', e.target.value)}
                      className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
                    />
                  </label>
                  <div className="flex items-end gap-2">
                    <button
                      type="button"
                      onClick={() => handleSave(entity.id)}
                      className="rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(entity.id)}
                      className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legal Holds tab
// ---------------------------------------------------------------------------

interface LegalHold {
  id: string;
  tenant_id: string;
  placed_by: string;
  reason: string;
  status: 'active' | 'pending_removal' | 'removed';
  placed_at: string;
  removed_at: string | null;
}

interface LegalHoldRemovalRequest {
  id: string;
  hold_id: string;
  requested_by: string;
  co_approved_by: string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  resolved_at: string | null;
  hold: LegalHold;
}

const HOLD_STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  pending_removal: 'bg-amber-50 text-amber-700 border-amber-200',
  removed: 'bg-zinc-100 text-zinc-500 border-zinc-300',
};

function HoldStatusBadge({ status }: { status: string }) {
  const colors = HOLD_STATUS_COLORS[status] ?? 'bg-zinc-50 text-zinc-600 border-zinc-200';
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${colors}`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

function LegalHoldsTab() {
  const [holds, setHolds] = useState<LegalHold[]>([]);
  const [pendingRemovals, setPendingRemovals] = useState<LegalHoldRemovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Place hold form state
  const [placeTenantId, setPlaceTenantId] = useState('');
  const [placeReason, setPlaceReason] = useState('');
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);

  // Action state
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [holdsRes, pendingRes] = await Promise.all([
        fetch('/api/legal-holds?limit=50', { credentials: 'include' }),
        fetch('/api/legal-holds/pending-removals?limit=50', { credentials: 'include' }),
      ]);

      if (holdsRes.ok) {
        const data = (await holdsRes.json()) as { holds: LegalHold[] };
        setHolds(data.holds ?? []);
      }

      if (pendingRes.ok) {
        const data = (await pendingRes.json()) as { requests: LegalHoldRemovalRequest[] };
        setPendingRemovals(data.requests ?? []);
      }
    } catch (err) {
      setError('Failed to load legal hold data.');
      console.error('Legal hold fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handlePlaceHold = useCallback(async () => {
    if (!placeTenantId.trim()) return;
    setPlacing(true);
    setPlaceError(null);
    try {
      const res = await fetch('/api/legal-holds', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: placeTenantId.trim(), reason: placeReason.trim() }),
      });
      if (res.ok) {
        setPlaceTenantId('');
        setPlaceReason('');
        await fetchData();
      } else {
        const data = (await res.json()) as { error?: string };
        setPlaceError(data.error ?? 'Failed to place hold.');
      }
    } catch (err) {
      setPlaceError('Network error placing hold.');
      console.error(err);
    } finally {
      setPlacing(false);
    }
  }, [placeTenantId, placeReason, fetchData]);

  const handleRequestRemoval = useCallback(
    async (holdId: string) => {
      setActionInProgress(holdId);
      setActionError(null);
      try {
        const res = await fetch(`/api/legal-holds/${holdId}/removal-request`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (res.ok) {
          await fetchData();
        } else {
          const data = (await res.json()) as { error?: string };
          setActionError(data.error ?? 'Failed to request removal.');
        }
      } catch (err) {
        setActionError('Network error.');
        console.error(err);
      } finally {
        setActionInProgress(null);
      }
    },
    [fetchData],
  );

  const handleApproveRemoval = useCallback(
    async (requestId: string) => {
      setActionInProgress(requestId);
      setActionError(null);
      try {
        const res = await fetch(`/api/legal-holds/removal-requests/${requestId}/approve`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (res.ok) {
          await fetchData();
        } else {
          const data = (await res.json()) as { error?: string };
          setActionError(data.error ?? 'Failed to approve removal.');
        }
      } catch (err) {
        setActionError('Network error.');
        console.error(err);
      } finally {
        setActionInProgress(null);
      }
    },
    [fetchData],
  );

  const handleRejectRemoval = useCallback(
    async (requestId: string) => {
      setActionInProgress(requestId);
      setActionError(null);
      try {
        const res = await fetch(`/api/legal-holds/removal-requests/${requestId}/reject`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (res.ok) {
          await fetchData();
        } else {
          const data = (await res.json()) as { error?: string };
          setActionError(data.error ?? 'Failed to reject removal.');
        }
      } catch (err) {
        setActionError('Network error.');
        console.error(err);
      } finally {
        setActionInProgress(null);
      }
    },
    [fetchData],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
        Loading legal holds...
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      {error && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Place a new hold */}
      <div className="border border-zinc-200 rounded-xl bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-800 mb-3">Place Legal Hold</h2>
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 flex-1">
            Tenant ID
            <input
              value={placeTenantId}
              onChange={(e) => setPlaceTenantId(e.target.value)}
              placeholder="tenant-id"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500 flex-1">
            Reason
            <input
              value={placeReason}
              onChange={(e) => setPlaceReason(e.target.value)}
              placeholder="Legal matter reference (optional)"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </label>
          <button
            onClick={() => void handlePlaceHold()}
            disabled={placing || !placeTenantId.trim()}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {placing ? 'Placing…' : 'Place Hold'}
          </button>
        </div>
        {placeError && <p className="mt-2 text-xs text-red-600">{placeError}</p>}
      </div>

      {/* Pending removal queue */}
      {pendingRemovals.length > 0 && (
        <div className="border border-amber-200 rounded-xl bg-amber-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-200 bg-amber-100">
            <h2 className="text-sm font-semibold text-amber-800">
              Pending Removal Requests ({pendingRemovals.length})
            </h2>
            <p className="text-xs text-amber-600 mt-0.5">
              A second Compliance Officer must co-approve each removal.
            </p>
          </div>
          <div className="divide-y divide-amber-100">
            {pendingRemovals.map((req) => (
              <div
                key={req.id}
                className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-zinc-500 truncate">Hold: {req.hold_id}</p>
                  <p className="text-sm text-zinc-800">
                    Tenant: <span className="font-medium">{req.hold.tenant_id}</span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    Reason: {req.hold.reason || <em>none</em>}
                  </p>
                  <p className="text-xs text-zinc-500">
                    Requested by: {req.requested_by} · {formatTimestamp(req.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => void handleApproveRemoval(req.id)}
                    disabled={actionInProgress === req.id}
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void handleRejectRemoval(req.id)}
                    disabled={actionInProgress === req.id}
                    className="px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
          {actionError && (
            <div className="px-4 py-2 bg-red-50 border-t border-red-200 text-xs text-red-600">
              {actionError}
            </div>
          )}
        </div>
      )}

      {/* All holds list */}
      <div className="border border-zinc-200 rounded-xl bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-100 bg-zinc-50 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-800">All Legal Holds ({holds.length})</h2>
          <button
            onClick={() => void fetchData()}
            className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-700 border border-zinc-200 rounded-md hover:bg-white transition-colors"
          >
            <RefreshCw size={11} />
            Refresh
          </button>
        </div>

        {holds.length === 0 ? (
          <div className="flex items-center justify-center h-16 text-zinc-400 text-sm italic">
            No legal holds found.
          </div>
        ) : (
          <div className="divide-y divide-zinc-50">
            {holds.map((hold) => (
              <div
                key={hold.id}
                className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <HoldStatusBadge status={hold.status} />
                    <span className="font-mono text-xs text-zinc-400 truncate">{hold.id}</span>
                  </div>
                  <p className="text-sm text-zinc-800">
                    Tenant: <span className="font-medium">{hold.tenant_id}</span>
                  </p>
                  {hold.reason && <p className="text-xs text-zinc-500">{hold.reason}</p>}
                  <p className="text-xs text-zinc-400">
                    Placed by {hold.placed_by} · {formatTimestamp(hold.placed_at)}
                    {hold.removed_at && ` · Removed ${formatTimestamp(hold.removed_at)}`}
                  </p>
                </div>
                {hold.status === 'active' && (
                  <button
                    onClick={() => void handleRequestRemoval(hold.id)}
                    disabled={actionInProgress === hold.id}
                    className="px-3 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 transition-colors shrink-0"
                  >
                    Request Removal
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type AdminTab = 'tasks' | 'users' | 'crm' | 'legal-holds';

export function AdminDashboard() {
  const [tasks, setTasks] = useState<TaskQueueEntry[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userLimit] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>('tasks');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(WS_RECONNECT_BASE_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Fetch helpers
  // ---------------------------------------------------------------------------

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

  const fetchUsers = useCallback(
    async (page: number, q: string) => {
      setLoadingUsers(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(userLimit),
        });
        if (q) params.set('q', q);
        const res = await fetch(`/api/admin/users?${params.toString()}`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setUsers(data.users ?? []);
          setUserTotal(data.total ?? 0);
        }
      } catch (err) {
        console.error('Admin dashboard user fetch error:', err);
      } finally {
        setLoadingUsers(false);
      }
    },
    [userLimit],
  );

  const fetchData = useCallback(() => {
    fetchTasks();
    fetchUsers(userPage, searchQuery);
  }, [fetchTasks, fetchUsers, userPage, searchQuery]);

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
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect on intentional close
        wsRef.current.close();
      }
    };
  }, []); // intentional: run once on mount; fetchData and connectWs are stable refs

  // ---------------------------------------------------------------------------
  // Debounced search
  // ---------------------------------------------------------------------------

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchInput(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchQuery(value);
      setUserPage(1);
    }, SEARCH_DEBOUNCE_MS);
  };

  // Re-fetch users when searchQuery or userPage changes
  useEffect(() => {
    fetchUsers(userPage, searchQuery);
  }, [fetchUsers, userPage, searchQuery]);

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------

  const totalPages = Math.max(1, Math.ceil(userTotal / userLimit));
  const pageStart = userTotal === 0 ? 0 : (userPage - 1) * userLimit + 1;
  const pageEnd = Math.min(userPage * userLimit, userTotal);

  const tabs: { id: AdminTab; label: string }[] = [
    { id: 'tasks', label: 'Task Queue' },
    { id: 'users', label: 'Users' },
    { id: 'crm', label: 'CRM' },
    { id: 'legal-holds', label: 'Legal Holds' },
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
          {/* Section header with search */}
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-zinc-700 uppercase tracking-wide">Users</h2>
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
              />
              <input
                type="text"
                value={searchInput}
                onChange={handleSearchChange}
                placeholder="Search users..."
                className="pl-8 pr-3 py-1.5 text-xs border border-zinc-200 rounded-lg bg-white text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 transition-colors w-52"
                aria-label="Search users"
              />
            </div>
          </div>

          <div className="border border-zinc-200 rounded-xl overflow-hidden bg-white">
            {loadingUsers ? (
              <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
                Loading users...
              </div>
            ) : users.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-zinc-400 text-sm">
                {searchQuery ? `No users match "${searchQuery}".` : 'No users found.'}
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

            {/* Pagination footer */}
            {userTotal > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-zinc-100 bg-zinc-50">
                <span className="text-xs text-zinc-500">
                  {pageStart}–{pageEnd} of {userTotal} user{userTotal !== 1 ? 's' : ''}
                  {searchQuery && (
                    <span className="ml-1 text-indigo-500">
                      matching &ldquo;{searchQuery}&rdquo;
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setUserPage((p) => Math.max(1, p - 1))}
                    disabled={userPage <= 1}
                    className="px-2 py-1 text-xs font-medium text-zinc-600 border border-zinc-200 rounded-md hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Previous
                  </button>
                  <span className="text-xs text-zinc-500">
                    Page {userPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setUserPage((p) => Math.min(totalPages, p + 1))}
                    disabled={userPage >= totalPages}
                    className="px-2 py-1 text-xs font-medium text-zinc-600 border border-zinc-200 rounded-md hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {/* CRM Tab */}
      {activeTab === 'crm' && <CrmEntitiesTab />}

      {/* Legal Holds Tab */}
      {activeTab === 'legal-holds' && <LegalHoldsTab />}
    </div>
  );
}

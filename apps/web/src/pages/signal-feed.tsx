/**
 * @file signal-feed.tsx
 *
 * Researcher signal feed page — issue #85.
 *
 * ## What this page provides
 *
 * - Live signal table sorted and filtered by event type, subject entity,
 *   confidence, and date range (acceptance criterion AC-1).
 * - Acknowledge, act, and dismiss actions per signal (AC-2).
 * - Signals are scoped to the authenticated researcher (AC-3: watchlist scoping
 *   enforced at the API layer via researcher_id).
 *
 * ## Canonical docs
 * - docs/prd.md §4, §7 — signal feed, outbound delivery
 * - docs/architecture.md §"Signal routing" — Delivered state
 * - apps/server/src/api/signal-feed-api.ts — API
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  ChevronUp,
  ChevronDown,
  Filter,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { useTopic } from '../context/TopicContext';
import { TopicSwitcher } from '../components/TopicSwitcher';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalFeedRow {
  id: string;
  ticker: string;
  event_type: string;
  confidence: number;
  source_trust: number;
  extraction_certainty: number;
  rationale: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  market_event_id: string;
}

export type SortKey =
  | 'created_at_desc'
  | 'created_at_asc'
  | 'confidence_desc'
  | 'confidence_asc'
  | 'event_type_asc'
  | 'event_type_desc';

export interface SignalFeedFilters {
  sort: SortKey;
  filter_type: string;
  filter_entity: string;
  filter_confidence_min: string;
  filter_date_from: string;
  filter_date_to: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export async function fetchSignals(
  filters: SignalFeedFilters,
  fetchImpl: typeof fetch = fetch,
  topicId?: string,
): Promise<SignalFeedRow[]> {
  const params = new URLSearchParams();
  params.set('sort', filters.sort);
  if (filters.filter_type) params.set('filter_type', filters.filter_type);
  if (filters.filter_entity) params.set('filter_entity', filters.filter_entity);
  if (filters.filter_confidence_min)
    params.set('filter_confidence_min', filters.filter_confidence_min);
  if (filters.filter_date_from) params.set('filter_date_from', filters.filter_date_from);
  if (filters.filter_date_to) params.set('filter_date_to', filters.filter_date_to);
  if (topicId) params.set('topic_id', topicId);

  const res = await fetchImpl(`/api/signals?${params.toString()}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { signals: SignalFeedRow[] };
  return data.signals;
}

export async function actionSignal(
  signalId: string,
  action: 'acknowledge' | 'act' | 'dismiss',
  fetchImpl: typeof fetch = fetch,
): Promise<{ signal_id: string; status: string; action: string }> {
  const res = await fetchImpl(`/api/signals/${signalId}/status`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<{ signal_id: string; status: string; action: string }>;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Confidence badge with color coding. */
function ConfidenceBadge({ value }: { value: number }): React.ReactElement {
  const pct = Math.round(value * 100);
  const color =
    pct >= 80
      ? 'bg-emerald-100 text-emerald-700'
      : pct >= 60
        ? 'bg-amber-100 text-amber-700'
        : 'bg-red-100 text-red-700';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}
      data-testid="confidence-badge"
    >
      {pct}%
    </span>
  );
}

/** Status pill. */
function StatusBadge({ status }: { status: string }): React.ReactElement {
  const colorMap: Record<string, string> = {
    Delivered: 'bg-indigo-100 text-indigo-700',
    Generated: 'bg-zinc-100 text-zinc-600',
    Queued: 'bg-amber-100 text-amber-700',
    Suppressed: 'bg-red-100 text-red-700',
  };
  const color = colorMap[status] ?? 'bg-zinc-100 text-zinc-600';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${color}`}>{status}</span>
  );
}

/** Sort toggle button for a column. */
function SortButton({
  label,
  ascKey,
  descKey,
  current,
  onSort,
}: {
  label: string;
  ascKey: SortKey;
  descKey: SortKey;
  current: SortKey;
  onSort: (k: SortKey) => void;
}): React.ReactElement {
  const isDesc = current === descKey;
  const isAsc = current === ascKey;
  const active = isDesc || isAsc;
  return (
    <button
      onClick={() => onSort(active && isDesc ? ascKey : descKey)}
      className={`flex items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors ${
        active ? 'text-indigo-600' : 'text-zinc-500 hover:text-zinc-700'
      }`}
      data-testid={`sort-${ascKey.replace(/_asc$/, '')}`}
    >
      {label}
      {active ? (
        isDesc ? (
          <ChevronDown size={12} />
        ) : (
          <ChevronUp size={12} />
        )
      ) : (
        <ChevronDown size={12} className="opacity-30" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

/**
 * SignalFeedPage — sortable, filterable researcher signal table.
 *
 * Fetches from GET /api/signals (session-cookie auth, scoped to logged-in researcher).
 * Scoped to the selected research topic when TopicContext is available.
 * Supports acknowledge/act/dismiss actions per row.
 */
export function SignalFeedPage(): React.ReactElement {
  const { activeTopic } = useTopic();
  const [signals, setSignals] = useState<SignalFeedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [filters, setFilters] = useState<SignalFeedFilters>({
    sort: 'created_at_desc',
    filter_type: '',
    filter_entity: '',
    filter_confidence_min: '',
    filter_date_from: '',
    filter_date_to: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchSignals(filters, fetch, activeTopic?.id);
      setSignals(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filters, activeTopic?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSort = useCallback((key: SortKey) => {
    setFilters((f) => ({ ...f, sort: key }));
  }, []);

  const handleAction = useCallback(
    async (signalId: string, action: 'acknowledge' | 'act' | 'dismiss') => {
      setActionPending(signalId);
      try {
        await actionSignal(signalId, action);
        // Optimistically update the local state
        if (action === 'dismiss') {
          setSignals((prev) =>
            prev.map((s) => (s.id === signalId ? { ...s, status: 'Suppressed' } : s)),
          );
        }
        // For acknowledge/act, just reload to reflect any server state change
        if (action !== 'dismiss') {
          await load();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setActionPending(null);
      }
    },
    [load],
  );

  const updateFilter = (key: keyof SignalFeedFilters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
  };

  return (
    <main aria-label="Signal feed" className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="border-b border-zinc-200 bg-white px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Zap size={20} className="text-indigo-600" strokeWidth={2.5} />
          <h1 className="text-lg font-semibold text-zinc-900">Signal Feed</h1>
          {signals.length > 0 && (
            <span className="bg-indigo-50 text-indigo-700 text-xs font-medium px-2 py-0.5 rounded-full">
              {signals.length}
            </span>
          )}
          <TopicSwitcher />
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          data-testid="signal-feed-refresh"
          className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700 disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Filter bar */}
      <div
        className="border-b border-zinc-200 bg-zinc-50 px-6 py-3 flex flex-wrap items-center gap-3 shrink-0"
        data-testid="signal-filter-bar"
        aria-label="Signal filters"
      >
        <Filter size={14} className="text-zinc-400 shrink-0" />

        <input
          type="text"
          placeholder="Event type (e.g. 8-K)"
          value={filters.filter_type}
          onChange={(e) => updateFilter('filter_type', e.target.value)}
          data-testid="filter-event-type"
          className="border border-zinc-200 rounded px-2 py-1 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white w-36"
        />

        <input
          type="text"
          placeholder="Entity / Ticker"
          value={filters.filter_entity}
          onChange={(e) => updateFilter('filter_entity', e.target.value)}
          data-testid="filter-entity"
          className="border border-zinc-200 rounded px-2 py-1 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white w-32"
        />

        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          placeholder="Min confidence"
          value={filters.filter_confidence_min}
          onChange={(e) => updateFilter('filter_confidence_min', e.target.value)}
          data-testid="filter-confidence-min"
          className="border border-zinc-200 rounded px-2 py-1 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white w-32"
        />

        <input
          type="date"
          value={filters.filter_date_from}
          onChange={(e) => updateFilter('filter_date_from', e.target.value)}
          data-testid="filter-date-from"
          aria-label="Filter from date"
          className="border border-zinc-200 rounded px-2 py-1 text-sm text-zinc-800 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
        />

        <span className="text-zinc-400 text-xs">to</span>

        <input
          type="date"
          value={filters.filter_date_to}
          onChange={(e) => updateFilter('filter_date_to', e.target.value)}
          data-testid="filter-date-to"
          aria-label="Filter to date"
          className="border border-zinc-200 rounded px-2 py-1 text-sm text-zinc-800 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
        />

        {(filters.filter_type ||
          filters.filter_entity ||
          filters.filter_confidence_min ||
          filters.filter_date_from ||
          filters.filter_date_to) && (
          <button
            onClick={() =>
              setFilters((f) => ({
                ...f,
                filter_type: '',
                filter_entity: '',
                filter_confidence_min: '',
                filter_date_from: '',
                filter_date_to: '',
              }))
            }
            className="text-xs text-red-500 hover:text-red-700 transition-colors"
            data-testid="clear-filters"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-center gap-2 shrink-0">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading && signals.length === 0 ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
          </div>
        ) : signals.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-40 text-zinc-400"
            data-testid="signal-feed-empty"
          >
            <Zap size={32} className="mb-2 opacity-30" />
            <p className="text-sm">No signals yet. Signals will appear here when delivered.</p>
          </div>
        ) : (
          <table
            className="w-full text-sm border-collapse"
            data-testid="signal-feed-table"
            aria-label="Signal feed table"
          >
            <thead>
              <tr className="bg-zinc-50 border-b border-zinc-200 sticky top-0">
                <th className="text-left px-4 py-3 font-medium text-zinc-500">
                  <SortButton
                    label="Ticker"
                    ascKey="event_type_asc"
                    descKey="event_type_desc"
                    current={filters.sort}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-zinc-500">
                  <SortButton
                    label="Event Type"
                    ascKey="event_type_asc"
                    descKey="event_type_desc"
                    current={filters.sort}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-zinc-500">
                  <SortButton
                    label="Confidence"
                    ascKey="confidence_asc"
                    descKey="confidence_desc"
                    current={filters.sort}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-zinc-500">
                  <SortButton
                    label="Date"
                    ascKey="created_at_asc"
                    descKey="created_at_desc"
                    current={filters.sort}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-zinc-500">Status</th>
                <th className="text-right px-4 py-3 font-medium text-zinc-500">Actions</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((signal) => (
                <React.Fragment key={signal.id}>
                  <tr
                    className={`border-b border-zinc-100 hover:bg-zinc-50 transition-colors cursor-pointer ${
                      signal.status === 'Suppressed' ? 'opacity-50' : ''
                    }`}
                    onClick={() => setExpandedId((id) => (id === signal.id ? null : signal.id))}
                    data-testid={`signal-row-${signal.id}`}
                    aria-expanded={expandedId === signal.id}
                  >
                    <td className="px-4 py-3 font-medium text-zinc-900">
                      <span data-testid="signal-ticker">{signal.ticker}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-700">
                      <span
                        className="bg-zinc-100 text-zinc-700 px-2 py-0.5 rounded text-xs font-mono"
                        data-testid="signal-event-type"
                      >
                        {signal.event_type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ConfidenceBadge value={signal.confidence} />
                    </td>
                    <td className="px-4 py-3 text-zinc-500 text-xs whitespace-nowrap">
                      {new Date(signal.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={signal.status} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div
                        className="flex items-center justify-end gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {signal.status === 'Delivered' && (
                          <>
                            <button
                              onClick={() => void handleAction(signal.id, 'acknowledge')}
                              disabled={actionPending === signal.id}
                              data-testid={`acknowledge-${signal.id}`}
                              title="Acknowledge"
                              className="p-1 rounded text-zinc-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-40"
                            >
                              <CheckCircle size={16} />
                            </button>
                            <button
                              onClick={() => void handleAction(signal.id, 'act')}
                              disabled={actionPending === signal.id}
                              data-testid={`act-${signal.id}`}
                              title="Act on signal"
                              className="p-1 rounded text-zinc-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors disabled:opacity-40"
                            >
                              <Zap size={16} />
                            </button>
                            <button
                              onClick={() => void handleAction(signal.id, 'dismiss')}
                              disabled={actionPending === signal.id}
                              data-testid={`dismiss-${signal.id}`}
                              title="Dismiss"
                              className="p-1 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                            >
                              <XCircle size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedId === signal.id && (
                    <tr
                      data-testid={`signal-rationale-${signal.id}`}
                      className="border-b border-zinc-100 bg-indigo-50/50"
                    >
                      <td colSpan={6} className="px-6 py-4">
                        <div className="text-xs text-zinc-500 font-semibold uppercase tracking-wide mb-1">
                          Rationale
                        </div>
                        <div className="text-sm text-zinc-700 whitespace-pre-wrap font-mono">
                          {signal.rationale ?? '(No rationale — evaluation stub)'}
                        </div>
                        <div className="mt-2 flex gap-4 text-xs text-zinc-400">
                          <span>Source trust: {(signal.source_trust * 100).toFixed(0)}%</span>
                          <span>
                            Extraction certainty: {(signal.extraction_certainty * 100).toFixed(0)}%
                          </span>
                          <span className="font-mono">Signal ID: {signal.id.slice(0, 12)}…</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

export default SignalFeedPage;

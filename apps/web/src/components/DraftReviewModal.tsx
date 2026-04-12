/**
 * @file DraftReviewModal.tsx
 *
 * Draft review UI for the autolearn publication gate (issue #66).
 *
 * Renders:
 *   - A line-level diff between the draft and the current published version.
 *   - A materiality indicator (material / immaterial, ratio, threshold).
 *   - Approve and Reject buttons.
 *
 * The approve button publishes the draft (POST /api/wiki/drafts/:id/approve).
 * The reject button closes the draft (POST /api/wiki/drafts/:id/reject).
 * Both require approval authority (enforced server-side; the UI fetches the
 * draft and will receive 403 if the user is not an approver).
 *
 * Blueprint references:
 * - PRD §5.5 — Draft vs. Published Wiki Versions
 * - Implementation plan Phase 6 — Publication gate UI
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/66
 */

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffHunk {
  type: 'unchanged' | 'removed' | 'added';
  line: string;
}

export interface MaterialityInfo {
  ratio: number;
  is_material: boolean;
  threshold: number;
}

export interface DraftReviewData {
  id: string;
  page_id: string;
  dept: string;
  customer: string;
  state: string;
  created_by: string;
  source_task: string | null;
  created_at: string;
  draft_content: string;
  published_version: { id: string; created_at: string } | null;
  diff: DiffHunk[];
  materiality: MaterialityInfo;
}

export interface DraftReviewModalProps {
  /** ID of the draft wiki_page_version to review. */
  draftId: string;
  /** Called when the modal is closed without action. */
  onClose: () => void;
  /** Called after a successful approve or reject. */
  onDecision: (decision: 'approved' | 'rejected') => void;
}

// ---------------------------------------------------------------------------
// DiffLine
// ---------------------------------------------------------------------------

function DiffLine({ hunk }: { hunk: DiffHunk }): React.ReactElement {
  const bg =
    hunk.type === 'added'
      ? 'bg-emerald-50 border-l-4 border-emerald-400'
      : hunk.type === 'removed'
        ? 'bg-red-50 border-l-4 border-red-400'
        : 'bg-white border-l-4 border-transparent';

  const prefix = hunk.type === 'added' ? '+ ' : hunk.type === 'removed' ? '- ' : '  ';

  const textColor =
    hunk.type === 'added'
      ? 'text-emerald-800'
      : hunk.type === 'removed'
        ? 'text-red-800'
        : 'text-zinc-600';

  return (
    <div
      className={`px-3 py-0.5 font-mono text-xs leading-relaxed whitespace-pre-wrap ${bg} ${textColor}`}
    >
      {prefix}
      {hunk.line}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MaterialityBadge
// ---------------------------------------------------------------------------

function MaterialityBadge({ materiality }: { materiality: MaterialityInfo }): React.ReactElement {
  const pct = Math.round(materiality.ratio * 100);
  const thresholdPct = Math.round(materiality.threshold * 100);

  if (materiality.is_material) {
    return (
      <div
        data-testid="materiality-badge-material"
        className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      >
        <AlertTriangle size={16} className="text-amber-500 shrink-0" />
        <span>
          <strong>Material change</strong> — {pct}% of lines changed (threshold: {thresholdPct}%).
          Explicit approval required before publication.
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="materiality-badge-immaterial"
      className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700"
    >
      <CheckCircle size={16} className="text-zinc-400 shrink-0" />
      <span>
        <strong>Immaterial change</strong> — {pct}% of lines changed (threshold: {thresholdPct}%).
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DraftReviewModal
// ---------------------------------------------------------------------------

/**
 * DraftReviewModal — fetches and displays a draft for review.
 *
 * Renders as a full-screen overlay with:
 *   - Header with draft metadata and close button
 *   - Materiality indicator
 *   - Approve / Reject controls
 *   - Line-level diff panel
 */
export function DraftReviewModal({
  draftId,
  onClose,
  onDecision,
}: DraftReviewModalProps): React.ReactElement {
  const [data, setData] = useState<DraftReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch draft data on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`/api/wiki/drafts/${encodeURIComponent(draftId)}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<DraftReviewData>;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load draft');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const handleApprove = useCallback(async () => {
    if (submitting) return;
    setSubmitting('approve');
    setActionError(null);
    try {
      const res = await fetch(`/api/wiki/drafts/${encodeURIComponent(draftId)}/approve`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onDecision('approved');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve draft');
      setSubmitting(null);
    }
  }, [draftId, submitting, onDecision]);

  const handleReject = useCallback(async () => {
    if (submitting) return;
    setSubmitting('reject');
    setActionError(null);
    try {
      const res = await fetch(`/api/wiki/drafts/${encodeURIComponent(draftId)}/reject`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onDecision('rejected');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to reject draft');
      setSubmitting(null);
    }
  }, [draftId, submitting, onDecision]);

  // Modal backdrop — close on backdrop click
  return (
    <div
      data-testid="draft-review-modal"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-12 px-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Draft review"
    >
      <div
        className="w-full max-w-4xl rounded-xl border border-zinc-200 bg-white shadow-2xl flex flex-col mb-12"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-zinc-200">
          <div>
            <h2 className="text-base font-semibold text-zinc-900">Review autolearn draft</h2>
            {data && (
              <p className="mt-0.5 text-xs text-zinc-500 font-mono">
                {data.customer} / {data.dept} — draft {data.id.slice(0, 8)}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-zinc-400" />
            </div>
          )}

          {error && <div className="p-6 text-sm text-red-600">Failed to load draft: {error}</div>}

          {data && !loading && (
            <>
              {/* Materiality + action controls */}
              <div className="px-5 py-4 space-y-3 border-b border-zinc-100">
                <MaterialityBadge materiality={data.materiality} />

                {actionError && <p className="text-sm text-red-600">{actionError}</p>}

                <div className="flex items-center gap-3">
                  <button
                    data-testid="approve-button"
                    onClick={handleApprove}
                    disabled={submitting !== null}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    <CheckCircle size={15} />
                    {submitting === 'approve' ? 'Publishing…' : 'Approve & publish'}
                  </button>

                  <button
                    data-testid="reject-button"
                    onClick={handleReject}
                    disabled={submitting !== null}
                    className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed text-red-700 border border-red-300 text-sm font-medium rounded-lg transition-colors"
                  >
                    <XCircle size={15} />
                    {submitting === 'reject' ? 'Rejecting…' : 'Reject'}
                  </button>

                  <div className="ml-auto text-xs text-zinc-400">
                    {data.published_version
                      ? `Comparing against published version ${data.published_version.id.slice(0, 8)}`
                      : 'No published version — this is the first version'}
                  </div>
                </div>
              </div>

              {/* Diff panel */}
              <div
                data-testid="diff-panel"
                className="flex-1 overflow-y-auto bg-zinc-50 border-t border-zinc-100 max-h-[60vh]"
              >
                {data.diff.length === 0 ? (
                  <div className="p-6 text-sm text-zinc-400 text-center">No diff to show.</div>
                ) : (
                  <div className="divide-y divide-zinc-100">
                    {data.diff.map((hunk, idx) => (
                      <DiffLine key={idx} hunk={hunk} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

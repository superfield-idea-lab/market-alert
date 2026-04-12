/**
 * @file wiki-view.tsx
 *
 * Read-only wiki view with version history panel.
 *
 * Implements the history panel UI for issue #47 (Phase 4 — Wiki web UX).
 *
 * ## Component hierarchy
 *
 *   WikiViewPage
 *   ├── WikiVersionPicker          — lists all prior WikiPageVersion entries
 *   │     └── WikiVersionCard      — shows created_by, source, timestamp
 *   └── WikiMarkdownRenderer       — renders markdown content of selected version
 *         └── CitationHoverCard    — revealed on hover over a cited claim (stub)
 *
 * ## Data flow
 *
 *   1. WikiViewPage fetches GET /api/wiki/pages/:customerId on mount.
 *   2. Version list is passed to WikiVersionPicker.
 *   3. The newest version is selected by default.
 *   4. Selecting a version updates rendered content.
 *   5. WikiMarkdownRenderer renders the selected version's markdown.
 *
 * Blueprint references:
 * - PRD §5.3 — history panel
 * - Implementation plan Phase 4 — Wiki web UX
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/47
 */

import React, { useCallback, useEffect, useState } from 'react';
import { PendingDraftsBadge } from '../components/PendingDraftsBadge';
import { WikiRender } from '../components/WikiRender';
import { AnnotationSidebar } from '../components/AnnotationThread';
import { DraftReviewModal } from '../components/DraftReviewModal';
import type { NewThreadAnchor, AnnotationThread } from '../components/AnnotationThread';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Summary of a single WikiPageVersion entry as returned by the version-list
 * endpoint (GET /api/wiki/pages/:customerId).
 */
export interface WikiPageVersionSummary {
  id: string;
  content: string;
  created_by: string;
  source: string | null;
  created_at: string;
  published: boolean;
}

/**
 * Resolved citation data returned by the citation-hover endpoint.
 * Matches CitationResolution in api/wiki-page-view.ts.
 */
export interface CitationResolution {
  token: string;
  entity_id: string;
  excerpt: string | null;
  source_id: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// WikiVersionCard
// ---------------------------------------------------------------------------

/**
 * WikiVersionCard — renders metadata for a single wiki version.
 *
 * Displays created_by, source, timestamp, and publication state.
 * Calls onSelect when clicked.
 */
export function WikiVersionCard({
  version,
  selected,
  onSelect,
  onReview,
}: {
  version: WikiPageVersionSummary;
  selected: boolean;
  onSelect: (id: string) => void;
  onReview?: (id: string) => void;
}): React.ReactElement {
  return (
    <div
      data-testid="wiki-version-card"
      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all ${
        selected
          ? 'border-indigo-400 bg-indigo-50 text-indigo-900'
          : 'border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50'
      }`}
    >
      <button
        className="w-full text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-400 rounded"
        onClick={() => onSelect(version.id)}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium truncate" data-testid="wiki-version-card-created-by">
            {version.created_by}
          </span>
          {version.published && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
              published
            </span>
          )}
          {!version.published && (
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
              draft
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-zinc-500" data-testid="wiki-version-card-timestamp">
          {formatTimestamp(version.created_at)}
        </div>
        {version.source && (
          <div
            className="mt-0.5 text-[11px] text-zinc-400 truncate"
            data-testid="wiki-version-card-source"
          >
            Source: {version.source}
          </div>
        )}
      </button>
      {!version.published && onReview && (
        <button
          data-testid="review-draft-button"
          onClick={() => onReview(version.id)}
          className="mt-2 w-full text-center text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded px-2 py-1 transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400"
        >
          Review draft
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WikiVersionPicker
// ---------------------------------------------------------------------------

/**
 * WikiVersionPicker — scrollable list of WikiVersionCard entries.
 *
 * Versions are displayed in the order provided (expected: reverse-chronological
 * from the API). The currently selected version is highlighted.
 */
export function WikiVersionPicker({
  versions,
  selectedId,
  onSelect,
  onReview,
}: {
  versions: WikiPageVersionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onReview?: (id: string) => void;
}): React.ReactElement {
  if (versions.length === 0) {
    return (
      <div
        data-testid="wiki-version-picker"
        className="flex-1 flex items-center justify-center text-zinc-400 text-xs"
      >
        No versions found.
      </div>
    );
  }

  return (
    <div data-testid="wiki-version-picker" className="flex flex-col gap-1.5">
      {versions.map((v) => (
        <WikiVersionCard
          key={v.id}
          version={v}
          selected={v.id === selectedId}
          onSelect={onSelect}
          onReview={onReview}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CitationHoverCard — stub (Phase 6)
// ---------------------------------------------------------------------------

/**
 * CitationHoverCard — stub.
 *
 * Will display CorpusChunk excerpt and source reference when a citation
 * anchor in the rendered markdown is hovered. Requires the re-identification
 * service (Phase 6).
 */
export function CitationHoverCard({
  resolution,
}: {
  resolution: CitationResolution | null;
}): React.ReactElement {
  if (!resolution) return <></>;
  return (
    <div
      data-testid="citation-hover-card"
      className="absolute z-10 max-w-xs rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-lg text-xs text-zinc-700"
    >
      {resolution.excerpt ? (
        <p>{resolution.excerpt}</p>
      ) : (
        <p className="text-zinc-400">No excerpt available.</p>
      )}
      {resolution.source_id && (
        <p className="mt-1 text-zinc-400 truncate">Source: {resolution.source_id}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WikiMarkdownRenderer
// ---------------------------------------------------------------------------

/**
 * WikiMarkdownRenderer — renders the markdown content of the selected version.
 *
 * Uses a safe whitelist-based approach: renders the markdown as preformatted
 * text to avoid XSS risk until a proper sanitised renderer (react-markdown)
 * is added in a follow-on issue.
 */
export function WikiMarkdownRenderer({
  content,
}: {
  content: string;
  customerId: string;
  versionId: string;
}): React.ReactElement {
  return (
    <article
      data-testid="wiki-markdown-renderer"
      className="prose prose-zinc prose-sm max-w-none p-4 whitespace-pre-wrap font-mono text-sm leading-relaxed text-zinc-800"
    >
      {content}
    </article>
  );
}

// ---------------------------------------------------------------------------
// WikiViewPage
// ---------------------------------------------------------------------------

export interface WikiViewPageProps {
  /** The customer whose wiki is being viewed. */
  customerId: string;
}

/**
 * WikiViewPage — history panel with version picker and markdown renderer.
 *
 * Fetches all accessible versions from GET /api/wiki/pages/:customerId,
 * displays them in a sidebar picker (reverse-chronological), and renders
 * the selected version's content.
 */
export function WikiViewPage({ customerId }: WikiViewPageProps): React.ReactElement {
  const [versions, setVersions] = useState<WikiPageVersionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<NewThreadAnchor | null>(null);
  const [threads, setThreads] = useState<AnnotationThread[]>([]);
  // Draft review modal state
  const [reviewDraftId, setReviewDraftId] = useState<string | null>(null);

  // Fetch version list — extracted so it can be called after a review decision.
  const fetchVersions = useCallback(
    (opts?: { signal?: AbortSignal }) => {
      setLoading(true);
      setError(null);

      fetch(`/api/wiki/pages/${encodeURIComponent(customerId)}`, {
        credentials: 'include',
        signal: opts?.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
          }
          return res.json() as Promise<{
            customer_id: string;
            versions: WikiPageVersionSummary[];
          }>;
        })
        .then((data) => {
          setVersions(data.versions);
          // Select the newest version by default (index 0 — API returns desc order).
          if (data.versions.length > 0) {
            setSelectedId((prev) => prev ?? data.versions[0].id);
          }
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === 'AbortError') return;
          setError(err instanceof Error ? err.message : 'Unknown error');
        })
        .finally(() => {
          setLoading(false);
        });
    },
    [customerId],
  );

  // Fetch version list on mount or when customerId changes.
  useEffect(() => {
    const controller = new AbortController();
    fetchVersions({ signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [fetchVersions]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleReview = useCallback((id: string) => {
    setReviewDraftId(id);
  }, []);

  const handleReviewClose = useCallback(() => {
    setReviewDraftId(null);
  }, []);

  const handleReviewDecision = useCallback(() => {
    setReviewDraftId(null);
    // Reload versions to reflect the new state
    fetchVersions();
  }, [fetchVersions]);

  const selectedVersion = versions.find((v) => v.id === selectedId) ?? null;

  if (loading) {
    return (
      <div data-testid="wiki-view-page" className="flex h-full items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-zinc-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="wiki-view-page" className="p-8 text-sm text-red-600">
        Failed to load wiki history: {error}
      </div>
    );
  }

  return (
    <>
      {reviewDraftId && (
        <DraftReviewModal
          draftId={reviewDraftId}
          onClose={handleReviewClose}
          onDecision={handleReviewDecision}
        />
      )}
      <div data-testid="wiki-view-page" className="flex h-full overflow-hidden">
        {/* History panel sidebar */}
        <aside
          data-testid="wiki-history-panel"
          className="w-64 shrink-0 border-r border-zinc-200 bg-zinc-50 flex flex-col overflow-hidden"
        >
          <div className="px-3 py-3 border-b border-zinc-200 shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">
                Version History
              </h2>
              <PendingDraftsBadge customerId={customerId} />
            </div>
            <p className="mt-0.5 text-[11px] text-zinc-400 font-mono truncate">{customerId}</p>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <WikiVersionPicker
              versions={versions}
              selectedId={selectedId}
              onSelect={handleSelect}
              onReview={handleReview}
            />
          </div>
        </aside>

        {/* Content area */}
        <main className="flex-1 flex overflow-hidden bg-white">
          {/* Wiki render area */}
          <div className="flex-1 overflow-y-auto">
            {selectedVersion ? (
              <WikiRender
                version={{
                  id: selectedVersion.id,
                  content: selectedVersion.content,
                  state: selectedVersion.published ? 'PUBLISHED' : 'AWAITING_REVIEW',
                  wiki_page_id: null,
                  tenant_id: null,
                  created_at: selectedVersion.created_at,
                  updated_at: selectedVersion.created_at,
                }}
                customerId={customerId}
                className="p-4"
                onTextSelected={setPendingAnchor}
                threads={threads}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-zinc-400 text-sm">
                {versions.length === 0
                  ? 'No versions found for this customer.'
                  : 'Select a version to view its content.'}
              </div>
            )}
          </div>

          {/* Annotation sidebar — only shown when a version is selected */}
          {selectedVersion && (
            <aside
              data-testid="annotation-sidebar-panel"
              className="w-64 shrink-0 border-l border-zinc-200 bg-zinc-50 overflow-y-auto"
            >
              <div className="px-3 py-2.5 border-b border-zinc-200">
                <h2 className="text-xs font-semibold text-zinc-600 uppercase tracking-wider">
                  Comments
                </h2>
              </div>
              <AnnotationSidebar
                customerId={customerId}
                versionId={selectedVersion.id}
                content={selectedVersion.content}
                pendingAnchor={pendingAnchor}
                onPendingAnchorCleared={() => setPendingAnchor(null)}
                onThreadsChange={setThreads}
              />
            </aside>
          )}
        </main>
      </div>
    </>
  );
}

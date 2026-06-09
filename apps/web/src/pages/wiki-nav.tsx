/**
 * @file wiki-nav.tsx
 *
 * Researcher wiki navigation page — issue #77.
 *
 * ## What this page provides
 *
 * - Browse all wiki pages for the researcher's tenant, filtered by subject type
 *   and searchable by subject ID.
 * - Drill into any page to see the currently published version body with visible
 *   citation edges (confirmed_facts and corpus_chunks).
 * - Navigate version history: prior indexed versions remain browsable.
 * - Open debate badge — pages with contested claims show a count.
 *
 * ## Security
 *
 * Uses the WIKI_REBUILD_TEST_TOKEN in TEST_MODE for internal API calls.
 * In production, the researcher session cookie scopes all access to the
 * researcher's own tenant.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §9 — wiki navigation.
 * - docs/implementation-plan.md Phase 4 — Wiki navigation UI.
 * - apps/server/src/api/wiki-nav-api.ts — API.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/77
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  BookOpen,
  ChevronRight,
  Search,
  AlertTriangle,
  Clock,
  ArrowLeft,
  FileText,
  Link,
} from 'lucide-react';
import { renderWikiMarkdown } from '../components/wiki-markdown';
import { DraftReviewModal } from '../components/DraftReviewModal';
import { useTopic } from '../context/TopicContext';
import { TopicSwitcher } from '../components/TopicSwitcher';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiPageSummary {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  currently_published_version_id: string | null;
  open_debate_count: number;
  created_at: string;
  updated_at: string;
}

export interface WikiVersionSummary {
  id: string;
  wiki_page_id: string;
  subject_type: string;
  subject_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CitationEdge {
  id: string;
  target_id: string;
  target_type: 'corpus_chunk' | 'confirmed_fact';
  created_at: string;
}

export interface WikiVersionDetail {
  id: string;
  subject_type: string;
  subject_id: string;
  body_ciphertext: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface WikiPageDetail {
  page: WikiPageSummary;
  current_version: WikiVersionDetail | null;
  citations: CitationEdge[];
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Citation badge
// ---------------------------------------------------------------------------

interface CitationBadgeProps {
  edge: CitationEdge;
}

function CitationBadge({ edge }: CitationBadgeProps) {
  const isChunk = edge.target_type === 'corpus_chunk';
  const label = isChunk ? 'Chunk' : 'Fact';
  const colour = isChunk
    ? 'bg-blue-50 text-blue-700 border-blue-200'
    : 'bg-green-50 text-green-700 border-green-200';
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${colour}`}
      title={`${edge.target_type}: ${edge.target_id}`}
    >
      <Link size={10} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Version history panel
// ---------------------------------------------------------------------------

interface VersionHistoryProps {
  wikiPageId: string;
  tenantId: string;
  currentVersionId: string | null;
  onSelectVersion: (versionId: string) => void;
  onDraftReview: (versionId: string) => void;
}

function VersionHistory({
  wikiPageId,
  currentVersionId,
  onSelectVersion,
  onDraftReview,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<WikiVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    apiGet<{ versions: WikiVersionSummary[] }>(`/api/wiki-nav/pages/${wikiPageId}/versions`)
      .then((data) => setVersions(data.versions))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [wikiPageId]);

  if (loading) return <p className="text-xs text-zinc-400">Loading version history…</p>;
  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (versions.length === 0) return <p className="text-xs text-zinc-400">No indexed versions.</p>;

  return (
    <div className="space-y-1">
      {versions.map((v) => {
        const isDraft = v.status === 'draft';
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => (isDraft ? onDraftReview(v.id) : onSelectVersion(v.id))}
            className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-all flex items-center justify-between gap-2 ${
              v.id === currentVersionId
                ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                : isDraft
                  ? 'hover:bg-amber-50 text-amber-700 border border-amber-200 hover:border-amber-300'
                  : 'hover:bg-zinc-50 text-zinc-600 border border-transparent hover:border-zinc-200'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <Clock size={11} />
              {new Date(v.created_at).toLocaleString()}
            </span>
            <span className="text-xs font-medium">
              {isDraft ? (
                <span className="text-amber-600">draft · review</span>
              ) : v.id === currentVersionId ? (
                <span className="text-indigo-500">current</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page detail view
// ---------------------------------------------------------------------------

interface PageDetailProps {
  page: WikiPageSummary;
  tenantId: string;
  onBack: () => void;
}

function PageDetail({ page, tenantId, onBack }: PageDetailProps) {
  const [detail, setDetail] = useState<WikiPageDetail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(
    page.currently_published_version_id,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reviewDraftId, setReviewDraftId] = useState<string | null>(null);

  const loadDetail = useCallback(
    async (versionId: string | null) => {
      setLoading(true);
      setError('');
      try {
        if (versionId && versionId !== page.currently_published_version_id) {
          // Load a specific prior version
          const data = await apiGet<{ version: WikiVersionDetail; citations: CitationEdge[] }>(
            `/api/wiki-nav/pages/${page.id}/versions/${versionId}`,
          );
          setDetail({
            page,
            current_version: data.version,
            citations: data.citations,
          });
        } else {
          // Load the page drill-in (currently published)
          const data = await apiGet<WikiPageDetail>(`/api/wiki-nav/pages/${page.id}`);
          setDetail(data);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load page detail');
      } finally {
        setLoading(false);
      }
    },
    [page],
  );

  useEffect(() => {
    void loadDetail(selectedVersionId);
  }, [loadDetail, selectedVersionId]);

  const handleVersionSelect = useCallback((versionId: string) => {
    setSelectedVersionId(versionId);
  }, []);

  return (
    <>
      {reviewDraftId && (
        <DraftReviewModal
          draftId={reviewDraftId}
          onClose={() => setReviewDraftId(null)}
          onDecision={() => {
            setReviewDraftId(null);
            void loadDetail(selectedVersionId);
          }}
        />
      )}
      <div className="flex gap-6 h-full">
        {/* Left: version history sidebar */}
        <div className="w-56 shrink-0 border-r border-zinc-100 pr-4 space-y-3">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-800 transition-colors"
          >
            <ArrowLeft size={12} />
            Back to wiki
          </button>

          <div>
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">
              Version history
            </p>
            <VersionHistory
              wikiPageId={page.id}
              tenantId={tenantId}
              currentVersionId={selectedVersionId}
              onSelectVersion={handleVersionSelect}
              onDraftReview={setReviewDraftId}
            />
          </div>
        </div>

        {/* Right: version body + citations */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Page header */}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                {page.subject_type}
              </span>
              {page.open_debate_count > 0 && (
                <span className="flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                  <AlertTriangle size={11} />
                  {page.open_debate_count} open debate{page.open_debate_count !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <h2 className="text-base font-semibold text-zinc-900 mt-1">{page.subject_id}</h2>
            {selectedVersionId && selectedVersionId !== page.currently_published_version_id && (
              <p className="text-xs text-amber-600 mt-0.5">Viewing a prior version</p>
            )}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {loading ? (
            <p className="text-sm text-zinc-400">Loading version…</p>
          ) : detail?.current_version ? (
            <>
              {/* Body */}
              <div
                data-testid="wiki-version-body"
                className="border border-zinc-200 rounded-xl p-4 bg-white prose prose-zinc prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: detail.current_version.body_ciphertext
                    ? renderWikiMarkdown(detail.current_version.body_ciphertext).html
                    : '<p class="text-zinc-400">(no content)</p>',
                }}
              />

              {/* Citations */}
              {detail.citations.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                    Citations ({detail.citations.length})
                  </p>
                  <div
                    className="flex flex-wrap gap-1.5"
                    data-testid="wiki-citations"
                    aria-label="Citation edges"
                  >
                    {detail.citations.map((c) => (
                      <CitationBadge key={c.id} edge={c} />
                    ))}
                  </div>
                </div>
              )}

              {detail.citations.length === 0 && (
                <p className="text-xs text-zinc-400">No citation edges for this version.</p>
              )}
            </>
          ) : (
            <div className="border border-zinc-100 rounded-xl p-8 text-center">
              <FileText size={28} className="text-zinc-300 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No published version yet.</p>
              <p className="text-xs text-zinc-400 mt-1">
                A wiki rebuild task will populate this page when facts are available.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page list / search
// ---------------------------------------------------------------------------

interface WikiNavListProps {
  tenantId: string;
  onSelectPage: (page: WikiPageSummary) => void;
}

function WikiNavList({ tenantId, onSelectPage }: WikiNavListProps) {
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [subjectTypeFilter, setSubjectTypeFilter] = useState('');

  const loadPages = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ tenant_id: tenantId });
      if (subjectTypeFilter) params.set('subject_type', subjectTypeFilter);
      if (query.trim()) params.set('q', query.trim());
      const data = await apiGet<{ pages: WikiPageSummary[] }>(
        `/api/wiki-nav/pages?${params.toString()}`,
      );
      setPages(data.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wiki pages');
    } finally {
      setLoading(false);
    }
  }, [tenantId, query, subjectTypeFilter]);

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  return (
    <div className="space-y-4">
      {/* Search + filter bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-2 text-zinc-400" />
          <input
            type="text"
            placeholder="Search by subject ID…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
            data-testid="wiki-search-input"
          />
        </div>
        <input
          type="text"
          placeholder="Subject type (e.g. company)"
          value={subjectTypeFilter}
          onChange={(e) => setSubjectTypeFilter(e.target.value)}
          className="w-48 px-3 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
          data-testid="wiki-type-filter"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-zinc-400">Loading wiki pages…</p>
      ) : pages.length === 0 ? (
        <div className="border border-zinc-200 rounded-xl p-8 text-center">
          <BookOpen size={32} className="text-zinc-300 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">No wiki pages found.</p>
          <p className="text-xs text-zinc-400 mt-1">
            Wiki pages are created automatically when facts are extracted for an entity.
          </p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="wiki-page-list">
          {pages.map((page) => (
            <button
              key={page.id}
              type="button"
              onClick={() => onSelectPage(page)}
              className="w-full text-left border border-zinc-200 rounded-xl p-4 hover:border-indigo-200 hover:bg-indigo-50 transition-all group"
              data-testid={`wiki-page-item-${page.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono text-indigo-600 bg-indigo-50 group-hover:bg-white px-1.5 py-0.5 rounded transition-colors">
                      {page.subject_type}
                    </span>
                    {page.open_debate_count > 0 && (
                      <span className="flex items-center gap-0.5 text-xs text-amber-600">
                        <AlertTriangle size={11} />
                        {page.open_debate_count}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-zinc-900 truncate">{page.subject_id}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {page.currently_published_version_id
                      ? `Published · updated ${new Date(page.updated_at).toLocaleDateString()}`
                      : 'No published version yet'}
                  </p>
                </div>
                <ChevronRight
                  size={14}
                  className="text-zinc-300 group-hover:text-indigo-400 transition-colors shrink-0 mt-1"
                />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export interface WikiNavPageProps {
  /**
   * Tenant ID for the current researcher session.
   * In production this comes from the session context; in storybook/test
   * it can be injected via props.
   */
  tenantId: string;
}

/**
 * WikiNavPage — researcher wiki navigation surface.
 *
 * Acceptance criteria (issue #77):
 * - AC-1: Researcher can browse and search the wiki and drill into any page.
 * - AC-2: Every claim links to its supporting source/fact (via citation badges).
 * - AC-3: A contested claim surfaces as a debate (open_debate_count badge).
 *
 * When TopicContext provides an active topic, wiki pages are scoped to that
 * topic's tenant_id. The prop tenantId serves as a fallback (e.g. in tests).
 */
export function WikiNavPage({ tenantId }: WikiNavPageProps): React.ReactElement {
  const { activeTopic } = useTopic();
  const [selected, setSelected] = useState<WikiPageSummary | null>(null);

  // Use active topic's tenant_id when available, falling back to the prop.
  const effectiveTenantId = activeTopic?.tenant_id ?? tenantId;

  if (selected) {
    return (
      <main aria-label="Wiki page detail" className="p-6 max-w-5xl h-full">
        <PageDetail page={selected} tenantId={effectiveTenantId} onBack={() => setSelected(null)} />
      </main>
    );
  }

  return (
    <main aria-label="Wiki navigation" className="p-6 max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Wiki</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Browse, search, and drill into knowledge pages. Citations link every claim to its
            supporting evidence.
          </p>
        </div>
        <TopicSwitcher />
      </div>

      <WikiNavList tenantId={effectiveTenantId} onSelectPage={setSelected} />
    </main>
  );
}

/**
 * @file sources-triggers.tsx
 *
 * Researcher Sources & Triggers settings page — issue #118.
 *
 * ## What this page provides
 *
 * - Sources tab: read-only list of canonical sources for the researcher's
 *   active Research Methodology — name, URL, trust tier, and live status.
 * - Triggers tab: list of standing prompts grouped by subject type
 *   (entity / thesis / portfolio), showing active version word count and
 *   pin state. Researcher can pin or unpin any standing prompt version.
 *
 * ## Canonical docs
 * - docs/prd.md §3, §5, §7 — researcher sources, standing-prompt routing, pin/override
 * - apps/server/src/api/researcher-settings-api.ts — backend API
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/118
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Globe, Zap, RefreshCw, Pin, PinOff } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearcherSourceRow {
  id: string;
  name: string;
  url: string;
  trust_tier: 'public' | 'authenticated' | 'api_key' | null;
  status: 'pending' | 'active' | 'retired';
}

export interface ResearcherStandingPromptRow {
  id: string;
  subject_type: 'entity' | 'thesis' | 'portfolio';
  subject_id: string;
  active_version_word_count: number | null;
  is_pinned: boolean | null;
  active_version_id: string | null;
}

export type ActiveTab = 'sources' | 'triggers';

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export async function fetchSources(
  fetchImpl: typeof fetch = fetch,
): Promise<ResearcherSourceRow[]> {
  const res = await fetchImpl('/api/researcher/sources', {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch sources: ${res.status}`);
  const data = (await res.json()) as { sources: ResearcherSourceRow[] };
  return data.sources;
}

export async function fetchStandingPrompts(
  fetchImpl: typeof fetch = fetch,
): Promise<ResearcherStandingPromptRow[]> {
  const res = await fetchImpl('/api/researcher/standing-prompts', {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to fetch standing prompts: ${res.status}`);
  const data = (await res.json()) as { standing_prompts: ResearcherStandingPromptRow[] };
  return data.standing_prompts;
}

export async function pinStandingPrompt(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`/api/researcher/standing-prompts/${id}/pin`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to pin standing prompt: ${res.status}`);
}

export async function unpinStandingPrompt(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`/api/researcher/standing-prompts/${id}/unpin`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to unpin standing prompt: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

function SourceStatusChip({ status }: { status: ResearcherSourceRow['status'] }) {
  const styles: Record<ResearcherSourceRow['status'], string> = {
    pending: 'bg-yellow-50 text-yellow-700 border border-yellow-200',
    active: 'bg-green-50 text-green-700 border border-green-200',
    retired: 'bg-zinc-100 text-zinc-500 border border-zinc-200',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function TrustTierChip({ tier }: { tier: ResearcherSourceRow['trust_tier'] }) {
  if (!tier) return <span className="text-zinc-400 text-xs">—</span>;
  const label: Record<NonNullable<ResearcherSourceRow['trust_tier']>, string> = {
    public: 'Public',
    authenticated: 'Authenticated',
    api_key: 'API Key',
  };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
      {label[tier]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sources tab
// ---------------------------------------------------------------------------

function SourcesTab({
  sources,
  loading,
  error,
}: {
  sources: ResearcherSourceRow[];
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
        {error}
      </div>
    );
  }

  if (sources.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-400 text-sm">
        No canonical sources registered for this tenant.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse" data-testid="sources-table">
        <thead>
          <tr className="border-b border-zinc-200">
            <th className="text-left py-3 px-4 font-medium text-zinc-600">Name</th>
            <th className="text-left py-3 px-4 font-medium text-zinc-600">URL</th>
            <th className="text-left py-3 px-4 font-medium text-zinc-600">Trust Tier</th>
            <th className="text-left py-3 px-4 font-medium text-zinc-600">Status</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr
              key={source.id}
              className="border-b border-zinc-100 hover:bg-zinc-50"
              data-testid="source-row"
            >
              <td className="py-3 px-4 font-medium text-zinc-900">{source.name}</td>
              <td className="py-3 px-4">
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-600 hover:underline truncate max-w-xs block"
                  data-testid="source-url"
                >
                  {source.url}
                </a>
              </td>
              <td className="py-3 px-4">
                <TrustTierChip tier={source.trust_tier} />
              </td>
              <td className="py-3 px-4">
                <SourceStatusChip status={source.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Triggers tab
// ---------------------------------------------------------------------------

const SUBJECT_TYPE_LABELS: Record<ResearcherStandingPromptRow['subject_type'], string> = {
  entity: 'Entity (per Ticker)',
  thesis: 'Thesis',
  portfolio: 'Portfolio (Fallback)',
};

function TriggersTab({
  prompts,
  loading,
  error,
  onPin,
  onUnpin,
  pinning,
}: {
  prompts: ResearcherStandingPromptRow[];
  loading: boolean;
  error: string | null;
  onPin: (id: string) => Promise<void>;
  onUnpin: (id: string) => Promise<void>;
  pinning: string | null;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
        {error}
      </div>
    );
  }

  if (prompts.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-400 text-sm">
        No standing prompts found. They will appear here once distillation runs.
      </div>
    );
  }

  // Group by subject_type
  const grouped: Record<string, ResearcherStandingPromptRow[]> = {};
  for (const prompt of prompts) {
    if (!grouped[prompt.subject_type]) grouped[prompt.subject_type] = [];
    grouped[prompt.subject_type]!.push(prompt);
  }

  const subjectTypes: ResearcherStandingPromptRow['subject_type'][] = [
    'entity',
    'thesis',
    'portfolio',
  ];

  return (
    <div className="space-y-6" data-testid="triggers-container">
      {subjectTypes
        .filter((st) => grouped[st] && grouped[st]!.length > 0)
        .map((subjectType) => (
          <div key={subjectType}>
            <h3 className="text-sm font-semibold text-zinc-700 mb-3">
              {SUBJECT_TYPE_LABELS[subjectType]}
            </h3>
            <div className="border border-zinc-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-zinc-50 border-b border-zinc-200">
                    <th className="text-left py-2 px-4 font-medium text-zinc-600">Subject ID</th>
                    <th className="text-left py-2 px-4 font-medium text-zinc-600">Word Count</th>
                    <th className="text-left py-2 px-4 font-medium text-zinc-600">Pin State</th>
                    <th className="text-right py-2 px-4 font-medium text-zinc-600">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped[subjectType]!.map((prompt) => (
                    <tr
                      key={prompt.id}
                      className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50"
                      data-testid="standing-prompt-row"
                    >
                      <td className="py-3 px-4 font-mono text-xs text-zinc-800">
                        {prompt.subject_id}
                      </td>
                      <td className="py-3 px-4 text-zinc-600">
                        {prompt.active_version_word_count !== null ? (
                          `${prompt.active_version_word_count} words`
                        ) : (
                          <span className="text-zinc-400">No active version</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {prompt.is_pinned === null ? (
                          <span className="text-zinc-400 text-xs">—</span>
                        ) : prompt.is_pinned ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"
                            data-testid="pinned-badge"
                          >
                            <Pin size={10} /> Pinned
                          </span>
                        ) : (
                          <span className="text-zinc-400 text-xs">Unpinned</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {prompt.active_version_id !== null && (
                          <button
                            onClick={() =>
                              prompt.is_pinned ? onUnpin(prompt.id) : onPin(prompt.id)
                            }
                            disabled={pinning === prompt.id}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50
                              border-zinc-200 text-zinc-600 hover:bg-zinc-50 hover:border-zinc-300"
                            data-testid={prompt.is_pinned ? 'unpin-button' : 'pin-button'}
                          >
                            {pinning === prompt.id ? (
                              <div className="w-3 h-3 animate-spin rounded-full border-b border-zinc-500" />
                            ) : prompt.is_pinned ? (
                              <>
                                <PinOff size={12} /> Unpin
                              </>
                            ) : (
                              <>
                                <Pin size={12} /> Pin
                              </>
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function SourcesTriggersPage() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('sources');
  const [sources, setSources] = useState<ResearcherSourceRow[]>([]);
  const [prompts, setPrompts] = useState<ResearcherStandingPromptRow[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [promptsLoading, setPromptsLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const data = await fetchSources();
      setSources(data);
    } catch (err) {
      setSourcesError(err instanceof Error ? err.message : 'Failed to load sources');
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  const loadPrompts = useCallback(async () => {
    setPromptsLoading(true);
    setPromptsError(null);
    try {
      const data = await fetchStandingPrompts();
      setPrompts(data);
    } catch (err) {
      setPromptsError(err instanceof Error ? err.message : 'Failed to load standing prompts');
    } finally {
      setPromptsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSources();
    void loadPrompts();
  }, [loadSources, loadPrompts]);

  const handlePin = useCallback(
    async (id: string) => {
      setPinning(id);
      try {
        await pinStandingPrompt(id);
        await loadPrompts();
      } catch {
        // silently ignore — UI will remain in previous state
      } finally {
        setPinning(null);
      }
    },
    [loadPrompts],
  );

  const handleUnpin = useCallback(
    async (id: string) => {
      setPinning(id);
      try {
        await unpinStandingPrompt(id);
        await loadPrompts();
      } catch {
        // silently ignore — UI will remain in previous state
      } finally {
        setPinning(null);
      }
    },
    [loadPrompts],
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-zinc-900">Sources & Triggers</h1>
        <p className="text-sm text-zinc-500 mt-1">
          View canonical sources and manage standing prompt pin state for your research pipeline.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-200 mb-6">
        <button
          onClick={() => setActiveTab('sources')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'sources'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-zinc-500 hover:text-zinc-700'
          }`}
          data-testid="tab-sources"
        >
          <Globe size={16} />
          Sources
        </button>
        <button
          onClick={() => setActiveTab('triggers')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'triggers'
              ? 'border-indigo-600 text-indigo-600'
              : 'border-transparent text-zinc-500 hover:text-zinc-700'
          }`}
          data-testid="tab-triggers"
        >
          <Zap size={16} />
          Triggers
        </button>

        {/* Refresh */}
        <div className="ml-auto flex items-center">
          <button
            onClick={() => {
              void loadSources();
              void loadPrompts();
            }}
            className="p-2 text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 rounded-lg transition-colors"
            title="Refresh"
            data-testid="refresh-button"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'sources' ? (
        <SourcesTab sources={sources} loading={sourcesLoading} error={sourcesError} />
      ) : (
        <TriggersTab
          prompts={prompts}
          loading={promptsLoading}
          error={promptsError}
          onPin={handlePin}
          onUnpin={handleUnpin}
          pinning={pinning}
        />
      )}
    </div>
  );
}

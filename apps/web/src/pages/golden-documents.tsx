/**
 * @file golden-documents.tsx
 *
 * Researcher authoring surface for golden documents (issue #73, PRD §6 §9).
 *
 * ## What this page provides
 *
 * - Create an `industry_definition` or `research_methodology` golden document.
 * - View and revise existing documents (add/edit sections).
 * - Activate a document (transitions it from 'authored' → 'active', retiring any
 *   previously active document of the same kind).
 * - Retire a document explicitly.
 *
 * ## Author-only invariant
 *
 * This surface is only rendered for authenticated researchers (session-cookie
 * auth). Worker Bearer tokens never reach this UI; they are rejected by the
 * API layer with 403. The three-layer DB enforcement (API + RLS + trigger) is
 * transparent to the UI.
 *
 * ## Canonical docs
 * - docs/prd.md §6, §9 — golden documents are author-only forever.
 * - docs/implementation-plan.md Phase 2.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { FileText, Plus, ChevronRight, CheckCircle, Archive, RefreshCw } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoldenDocument {
  id: string;
  kind: 'industry_definition' | 'research_methodology';
  title: string;
  author_id: string;
  tenant_id: string;
  state: 'authored' | 'active' | 'retired';
  created_at: string;
  updated_at: string;
}

export interface GoldenDocumentSection {
  id: string;
  document_id: string;
  section_key: string;
  content: string;
  position: number;
  created_at: string;
  updated_at: string;
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

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((errBody as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((errBody as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface StateChipProps {
  state: GoldenDocument['state'];
}

function StateChip({ state }: StateChipProps) {
  const colours = {
    authored: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    active: 'bg-green-50 text-green-700 border-green-200',
    retired: 'bg-zinc-100 text-zinc-500 border-zinc-200',
  } as const;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colours[state]}`}
    >
      {state}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section editor
// ---------------------------------------------------------------------------

interface SectionEditorProps {
  docId: string;
  onSaved: () => void;
}

function SectionEditor({ docId, onSaved }: SectionEditorProps) {
  const [sectionKey, setSectionKey] = useState('');
  const [content, setContent] = useState('');
  const [position, setPosition] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = useCallback(async () => {
    if (!sectionKey.trim()) {
      setError('Section key is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiPost(`/api/golden-documents/${docId}/sections`, {
        section_key: sectionKey.trim(),
        content,
        position,
      });
      setSectionKey('');
      setContent('');
      setPosition(0);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save section');
    } finally {
      setSaving(false);
    }
  }, [docId, sectionKey, content, position, onSaved]);

  return (
    <div className="border border-zinc-200 rounded-xl p-4 space-y-3 bg-zinc-50">
      <h4 className="text-xs font-semibold text-zinc-600 uppercase tracking-wide">
        Add / Edit Section
      </h4>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="grid grid-cols-3 gap-2">
        <input
          type="text"
          placeholder="section_key (e.g. overview)"
          value={sectionKey}
          onChange={(e) => setSectionKey(e.target.value)}
          className="col-span-2 px-2 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
        <input
          type="number"
          placeholder="position"
          value={position}
          onChange={(e) => setPosition(Number(e.target.value))}
          className="px-2 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
      </div>
      <textarea
        placeholder="Section content (Markdown supported)"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        className="w-full px-2 py-1.5 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 font-mono resize-y"
      />
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving…' : 'Save section'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document detail view
// ---------------------------------------------------------------------------

interface DocumentDetailProps {
  doc: GoldenDocument;
  onBack: () => void;
  onRefresh: () => void;
}

function DocumentDetail({ doc, onBack, onRefresh }: DocumentDetailProps) {
  const [sections, setSections] = useState<GoldenDocumentSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState('');

  const loadSections = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<{ sections: GoldenDocumentSection[] }>(
        `/api/golden-documents/${doc.id}/sections`,
      );
      setSections(data.sections);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sections');
    } finally {
      setLoading(false);
    }
  }, [doc.id]);

  useEffect(() => {
    void loadSections();
  }, [loadSections]);

  const handleStateChange = useCallback(
    async (newState: 'active' | 'retired') => {
      setTransitioning(true);
      setError('');
      try {
        await apiPatch(`/api/golden-documents/${doc.id}/state`, { state: newState });
        onRefresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'State transition failed');
      } finally {
        setTransitioning(false);
      }
    },
    [doc.id, onRefresh],
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-zinc-500 hover:text-zinc-800 flex items-center gap-1"
        >
          <ChevronRight size={14} className="rotate-180" /> Back
        </button>
        <div className="flex-1" />
        <StateChip state={doc.state} />
      </div>

      <div>
        <h2 className="text-base font-semibold text-zinc-900">{doc.title}</h2>
        <p className="text-xs text-zinc-400 mt-0.5">
          {doc.kind.replace('_', ' ')} · created {new Date(doc.created_at).toLocaleDateString()}
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {/* State actions */}
      {doc.state !== 'active' && (
        <button
          type="button"
          onClick={() => void handleStateChange('active')}
          disabled={transitioning}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          <CheckCircle size={14} />
          {transitioning ? 'Activating…' : 'Activate'}
        </button>
      )}
      {doc.state !== 'retired' && (
        <button
          type="button"
          onClick={() => void handleStateChange('retired')}
          disabled={transitioning}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-zinc-200 text-zinc-600 rounded-lg hover:bg-zinc-50 disabled:opacity-50 transition-colors"
        >
          <Archive size={14} />
          {transitioning ? 'Retiring…' : 'Retire'}
        </button>
      )}

      {/* Sections */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-zinc-700">Sections</h3>
          <button
            type="button"
            onClick={() => void loadSections()}
            className="text-xs text-zinc-400 hover:text-zinc-600 flex items-center gap-1"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-zinc-400">Loading sections…</p>
        ) : sections.length === 0 ? (
          <p className="text-sm text-zinc-400">No sections yet. Add one below.</p>
        ) : (
          <div className="space-y-2">
            {sections.map((section) => (
              <div
                key={section.id}
                className="border border-zinc-100 rounded-xl p-3 bg-white space-y-1"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-semibold text-indigo-600">
                    {section.section_key}
                  </span>
                  <span className="text-xs text-zinc-400">pos {section.position}</span>
                </div>
                <pre className="text-xs text-zinc-700 whitespace-pre-wrap font-mono break-words">
                  {section.content}
                </pre>
              </div>
            ))}
          </div>
        )}

        {/* Section editor — only allow edits on non-retired docs */}
        {doc.state !== 'retired' && (
          <div className="mt-4">
            <SectionEditor docId={doc.id} onSaved={() => void loadSections()} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create document form
// ---------------------------------------------------------------------------

interface CreateDocFormProps {
  onCreated: (doc: GoldenDocument) => void;
}

function CreateDocForm({ onCreated }: CreateDocFormProps) {
  const [kind, setKind] = useState<'industry_definition' | 'research_methodology'>(
    'industry_definition',
  );
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = useCallback(async () => {
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const data = await apiPost<{ document: GoldenDocument }>('/api/golden-documents', {
        kind,
        title: title.trim(),
      });
      setTitle('');
      onCreated(data.document);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create document');
    } finally {
      setCreating(false);
    }
  }, [kind, title, onCreated]);

  return (
    <div className="border border-indigo-100 rounded-xl p-4 bg-indigo-50 space-y-3">
      <h3 className="text-sm font-semibold text-indigo-700">Create new golden document</h3>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="space-y-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          className="w-full px-2 py-1.5 text-sm border border-indigo-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
        >
          <option value="industry_definition">Industry Definition</option>
          <option value="research_methodology">Research Methodology</option>
        </select>
        <input
          type="text"
          placeholder="Document title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
          className="w-full px-2 py-1.5 text-sm border border-indigo-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating}
          className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <Plus size={14} />
          {creating ? 'Creating…' : 'Create'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

/**
 * GoldenDocumentsPage — researcher authoring surface.
 *
 * Renders the list of the researcher's golden documents and provides
 * create / activate / retire / section editing controls.
 */
export function GoldenDocumentsPage(): React.ReactElement {
  const [documents, setDocuments] = useState<GoldenDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<GoldenDocument | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet<{ documents: GoldenDocument[] }>('/api/golden-documents');
      setDocuments(data.documents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const handleCreated = useCallback(
    (doc: GoldenDocument) => {
      setShowCreate(false);
      void loadDocuments().then(() => setSelected(doc));
    },
    [loadDocuments],
  );

  const handleRefresh = useCallback(async () => {
    await loadDocuments();
    // Re-select the document with updated state.
    if (selected) {
      const data = await apiGet<{ document: GoldenDocument }>(
        `/api/golden-documents/${selected.id}`,
      ).catch(() => null);
      if (data) setSelected(data.document);
    }
  }, [loadDocuments, selected]);

  // Detail view
  if (selected) {
    return (
      <main aria-label="Golden document detail" className="p-6 max-w-2xl">
        <DocumentDetail
          doc={selected}
          onBack={() => {
            setSelected(null);
            void loadDocuments();
          }}
          onRefresh={handleRefresh}
        />
      </main>
    );
  }

  // List view
  return (
    <main aria-label="Golden documents" className="p-6 max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">Golden Documents</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            Author-only: Industry Definition and Research Methodology.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          data-testid="golden-documents-create-btn"
        >
          <Plus size={14} />
          New document
        </button>
      </div>

      {showCreate && <CreateDocForm onCreated={handleCreated} />}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-zinc-400">Loading documents…</p>
      ) : documents.length === 0 ? (
        <div className="border border-zinc-200 rounded-xl p-8 text-center">
          <FileText size={32} className="text-zinc-300 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">No golden documents yet.</p>
          <p className="text-xs text-zinc-400 mt-1">
            Create your Industry Definition or Research Methodology above.
          </p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="golden-documents-list">
          {documents.map((doc) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => setSelected(doc)}
              className="w-full text-left border border-zinc-200 rounded-xl p-4 hover:border-indigo-200 hover:bg-indigo-50 transition-all group"
              data-testid={`golden-doc-item-${doc.id}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 truncate">{doc.title}</p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {doc.kind.replace('_', ' ')} · {new Date(doc.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <StateChip state={doc.state} />
                  <ChevronRight
                    size={14}
                    className="text-zinc-300 group-hover:text-indigo-400 transition-colors"
                  />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

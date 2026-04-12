/**
 * @file wiki-view.tsx
 *
 * Read-only rendered wiki view with version picker and citation hover.
 *
 * ## Scout stub (Phase 4, issue #45)
 *
 * This component is a **no-op stub** for the dev-scout issue. It renders a
 * placeholder UI with the planned component hierarchy documented so follow-on
 * implementation issues can build against a stable surface.
 *
 * ## Planned component hierarchy
 *
 *   WikiViewPage
 *   ├── WikiVersionPicker          — lists all prior WikiPageVersion entries
 *   │     └── WikiVersionCard      — shows created_by, source, timestamp
 *   └── WikiMarkdownRenderer       — renders markdown content of selected version
 *         └── CitationHoverCard    — revealed on hover over a cited claim
 *
 * ## Planned data flow
 *
 *   1. WikiViewPage fetches GET /api/wiki/pages/:customerId on mount.
 *   2. Version list is passed to WikiVersionPicker.
 *   3. Selecting a version fetches GET /api/wiki/pages/:customerId/versions/:id.
 *   4. Markdown is rendered by WikiMarkdownRenderer.
 *   5. Hovering a citation anchor calls
 *      GET /api/wiki/pages/:customerId/versions/:id/citations/:token.
 *   6. CitationHoverCard displays the resolved CorpusChunk excerpt.
 *
 * Blueprint references:
 * - PRD §4.3 — read-only wiki rendering
 * - Implementation plan Phase 4 — Wiki web UX
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/45
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Type stubs — will be driven by the real API response shapes in Phase 4
// ---------------------------------------------------------------------------

/**
 * Summary of a single WikiPageVersion entry as returned by the version-list
 * endpoint. Matches WikiPageVersionSummary in api/wiki-page-view.ts.
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
// Sub-component stubs
// ---------------------------------------------------------------------------

/**
 * WikiVersionCard — stub.
 *
 * Planned: display created_by, source, and timestamp for one wiki version.
 * On click: update selected version in WikiViewPage state.
 */
export function WikiVersionCard(_props: {
  version: WikiPageVersionSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}): React.ReactElement {
  // Stub — not yet implemented (Phase 4).
  return (
    <div data-testid="wiki-version-card-stub" className="hidden">
      stub
    </div>
  );
}

/**
 * WikiVersionPicker — stub.
 *
 * Planned: render a scrollable list of WikiVersionCard entries ordered by
 * version descending.
 */
export function WikiVersionPicker(_props: {
  versions: WikiPageVersionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.ReactElement {
  // Stub — not yet implemented (Phase 4).
  return (
    <div data-testid="wiki-version-picker-stub" className="hidden">
      stub
    </div>
  );
}

/**
 * CitationHoverCard — stub.
 *
 * Planned: display CorpusChunk excerpt and source reference when a citation
 * anchor in the rendered markdown is hovered.
 */
export function CitationHoverCard(_props: {
  resolution: CitationResolution | null;
}): React.ReactElement {
  // Stub — not yet implemented (Phase 4).
  return (
    <div data-testid="citation-hover-card-stub" className="hidden">
      stub
    </div>
  );
}

/**
 * WikiMarkdownRenderer — stub.
 *
 * Planned: render the markdown content of the selected WikiPageVersion using
 * a safe Markdown renderer (e.g. react-markdown). Each citation anchor
 * `[^N]` triggers a CitationHoverCard on mouseenter.
 */
export function WikiMarkdownRenderer(_props: {
  content: string;
  customerId: string;
  versionId: string;
}): React.ReactElement {
  // Stub — not yet implemented (Phase 4).
  return (
    <div data-testid="wiki-markdown-renderer-stub" className="hidden">
      stub
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export interface WikiViewPageProps {
  /** The customer whose wiki is being viewed. */
  customerId: string;
}

/**
 * WikiViewPage — Scout stub.
 *
 * Renders a placeholder that communicates the pending implementation to devs
 * and QA while keeping the route wired and TypeScript-clean.
 */
export function WikiViewPage({ customerId }: WikiViewPageProps): React.ReactElement {
  return (
    <div
      data-testid="wiki-view-page"
      className="p-8 max-w-3xl mx-auto text-zinc-500 text-sm space-y-4"
    >
      <h2 className="text-base font-semibold text-zinc-900">Wiki</h2>
      <p className="text-xs text-zinc-400">
        Customer: <span className="font-mono text-zinc-600">{customerId}</span>
      </p>
      <p className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-6 text-center text-zinc-400">
        Read-only wiki view is not yet implemented.
        <br />
        <span className="text-xs">Phase 4 — issue #45</span>
      </p>

      {/* Sub-component stubs — hidden, present for type-checking only */}
      <WikiVersionPicker versions={[]} selectedId={null} onSelect={() => undefined} />
      <WikiMarkdownRenderer content="" customerId={customerId} versionId="" />
      <CitationHoverCard resolution={null} />
    </div>
  );
}

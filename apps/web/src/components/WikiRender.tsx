/**
 * @file WikiRender.tsx
 *
 * Shared wiki render component for `apps/web`.
 *
 * Renders a `WikiPageVersion`'s markdown content as sanitised HTML and exposes
 * citation markers as interactive targets for downstream features (citation
 * hover, annotations).
 *
 * ## Usage
 *
 * ```tsx
 * <WikiRender
 *   version={wikiPageVersion}
 *   onCitationClick={(citationId) => { ... }}
 * />
 * ```
 *
 * ## Architecture
 *
 * The component delegates all markdown parsing and sanitisation to the
 * `wiki-markdown` pipeline module. It is the **single** entry point for
 * rendering wiki markdown in the web app — see the `renderWikiMarkdown`
 * function for pipeline details.
 *
 * ## Citation interaction
 *
 * After the HTML is injected into the DOM the component attaches a single
 * delegated click listener to the container `<article>`. Clicks on
 * `<sup class="wiki-citation">` elements bubble up and are forwarded to the
 * `onCitationClick` callback with the `data-citation-id` value. The actual
 * citation hover UI is a Phase 4 follow-on issue.
 *
 * References:
 * - docs/implementation-plan-v1.md §Phase 4 — Wiki web UX
 * - @see https://github.com/superfield-ai/superfield-kb-demo/issues/46
 */

import React, { useEffect, useMemo, useRef } from 'react';
import type { WikiPageVersion } from 'core';
import { renderWikiMarkdown } from './wiki-markdown';
import type { CitationMarker } from './wiki-markdown';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WikiRenderProps {
  /** The wiki page version to render. */
  version: WikiPageVersion;
  /**
   * Optional callback invoked when a citation marker is clicked.
   *
   * @param citationId - The raw citation identifier, e.g. `"abc123"`.
   */
  onCitationClick?: (citationId: string) => void;
  /**
   * Optional callback that receives the list of all citation markers found in
   * the rendered content. Useful for building citation panels or hover cards
   * without interrogating the DOM directly.
   */
  onCitationsReady?: (citations: CitationMarker[]) => void;
  /** Optional extra CSS class names for the outer `<article>` element. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * WikiRender — the single markdown renderer for wiki content in `apps/web`.
 *
 * Uses `dangerouslySetInnerHTML` with DOMPurify-sanitised output; the
 * `wiki-markdown` module enforces the allowlist.
 */
export function WikiRender({
  version,
  onCitationClick,
  onCitationsReady,
  className,
}: WikiRenderProps): React.ReactElement {
  const containerRef = useRef<HTMLElement>(null);

  // Memoise the render result — re-compute only when the markdown changes.
  const { html, citations } = useMemo(() => renderWikiMarkdown(version.content), [version.content]);

  // Notify caller of citation list whenever it changes.
  useEffect(() => {
    if (onCitationsReady) {
      onCitationsReady(citations);
    }
  }, [citations, onCitationsReady]);

  // Attach a delegated click listener for citation markers.
  useEffect(() => {
    if (!onCitationClick) return;
    const container = containerRef.current;
    if (!container) return;

    function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const citation = target.closest('sup.wiki-citation');
      if (!citation) return;
      const citationId = (citation as HTMLElement).dataset.citationId;
      if (citationId) {
        onCitationClick!(citationId);
      }
    }

    container.addEventListener('click', handleClick);
    return () => {
      container.removeEventListener('click', handleClick);
    };
  }, [onCitationClick]);

  return (
    <article
      ref={containerRef}
      className={['wiki-render', className].filter(Boolean).join(' ')}
      data-wiki-version-id={version.id}
      data-wiki-state={version.state}
      // DOMPurify-sanitised HTML — safe to inject.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

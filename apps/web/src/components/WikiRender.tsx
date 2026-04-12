/**
 * @file WikiRender.tsx
 *
 * Shared wiki render component for `apps/web`.
 *
 * Renders a `WikiPageVersion`'s markdown content as sanitised HTML and exposes
 * citation markers as interactive hover targets. Hovering a citation fetches
 * the linked CorpusChunk and optionally resolves the sender/speaker name via
 * the re-identification API (issue #49).
 *
 * ## Usage
 *
 * ```tsx
 * <WikiRender
 *   version={wikiPageVersion}
 *   customerId="customer-123"
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
 * ## Citation hover
 *
 * Mouseover on `<sup class="wiki-citation">` triggers a fetch to
 * GET /api/wiki/pages/:customerId/versions/:versionId/citations/:token.
 * The response is rendered in a `CitationHoverPopover` positioned next to
 * the citation marker. Non-superusers see the excerpt only; superusers also
 * see the resolved sender/speaker name.
 *
 * ## Citation click / tap
 *
 * Clicks and touch taps on citation markers also invoke the optional
 * `onCitationClick` callback for callers that want to handle citations
 * differently. A delegated `touchend` listener handles touch devices so
 * the interaction works on the mobile PWA surface without the synthetic
 * click delay.
 *
 * References:
 * - docs/implementation-plan-v1.md §Phase 4 — Wiki web UX
 * - @see https://github.com/superfield-ai/superfield-kb-demo/issues/49
 * - @see https://github.com/superfield-ai/superfield-kb-demo/issues/51
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WikiPageVersion } from '../../../../packages/core/types';
import { renderWikiMarkdown } from './wiki-markdown';
import type { CitationMarker } from './wiki-markdown';
import {
  CitationHoverPopover,
  type CitationHoverState,
  type CitationResolution,
} from './CitationHoverPopover';
import type { NewThreadAnchor, AnnotationThread } from './AnnotationThread';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WikiRenderProps {
  /** The wiki page version to render. */
  version: WikiPageVersion;
  /**
   * Customer identifier used to build the citation resolution API path.
   * Required for citation hover to work; omit only when hover is not needed.
   */
  customerId?: string;
  /**
   * Optional callback invoked when a citation marker is clicked or tapped.
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
  /**
   * Optional callback invoked when the user selects text, providing the
   * selection anchor data needed to open a new annotation thread form.
   * When omitted, text selection does not trigger any annotation UI.
   */
  onTextSelected?: (anchor: NewThreadAnchor) => void;
  /**
   * Current annotation threads for the rendered version.
   * When provided, anchor highlights are rendered over the text.
   */
  threads?: AnnotationThread[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * WikiRender — the single markdown renderer for wiki content in `apps/web`.
 *
 * Uses `dangerouslySetInnerHTML` with DOMPurify-sanitised output; the
 * `wiki-markdown` module enforces the allowlist.
 *
 * When `customerId` is provided, hovering a citation marker fetches the
 * citation resolution from the server and renders a `CitationHoverPopover`.
 */
export function WikiRender({
  version,
  customerId,
  onCitationClick,
  onCitationsReady,
  className,
  onTextSelected,
  threads,
}: WikiRenderProps): React.ReactElement {
  const containerRef = useRef<HTMLElement>(null);

  // Memoise the render result — re-compute only when the markdown changes.
  const { html, citations } = useMemo(() => renderWikiMarkdown(version.content), [version.content]);

  // Citation hover state — drives the CitationHoverPopover.
  const [hoverState, setHoverState] = useState<CitationHoverState>({ status: 'idle' });

  // Notify caller of citation list whenever it changes.
  useEffect(() => {
    if (onCitationsReady) {
      onCitationsReady(citations);
    }
  }, [citations, onCitationsReady]);

  // Fetch citation resolution from the server.
  const fetchCitation = useCallback(
    async (citationId: string, anchorRect: DOMRect) => {
      if (!customerId) return;

      setHoverState({ status: 'loading', citationId, anchorRect });

      const url = `/api/wiki/pages/${encodeURIComponent(customerId)}/versions/${encodeURIComponent(version.id)}/citations/${encodeURIComponent(citationId)}`;

      try {
        const res = await fetch(url, { credentials: 'include' });

        if (res.status === 401 || res.status === 403) {
          setHoverState({ status: 'unauthorized', citationId, anchorRect });
          return;
        }

        if (res.status === 404) {
          setHoverState({
            status: 'error',
            citationId,
            anchorRect,
            message: 'Citation source not found.',
          });
          return;
        }

        if (!res.ok) {
          setHoverState({
            status: 'error',
            citationId,
            anchorRect,
            message: 'Failed to load citation.',
          });
          return;
        }

        const resolution: CitationResolution = await res.json();
        setHoverState({ status: 'loaded', citationId, anchorRect, resolution });
      } catch {
        setHoverState({
          status: 'error',
          citationId,
          anchorRect,
          message: 'Network error loading citation.',
        });
      }
    },
    [customerId, version.id],
  );

  const closePopover = useCallback(() => {
    setHoverState({ status: 'idle' });
  }, []);

  // ── Text-selection → annotation anchor ───────────────────────────────────
  // When the user lifts the mouse inside the article, check whether there is a
  // non-empty selection that falls inside the container.  If so, invoke
  // onTextSelected with the anchor data so the parent can open the new-thread
  // form.  Character offsets are computed against the raw version content so
  // they remain stable for storage and fuzzy re-anchoring.
  useEffect(() => {
    if (!onTextSelected) return;
    const container = containerRef.current;
    if (!container) return;

    function handleMouseUp() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const selectedText = sel.toString().trim();
      if (!selectedText) return;

      // Confirm the selection is inside our article.
      if (!container!.contains(range.commonAncestorContainer)) return;

      // Compute character offsets within the raw content string by counting
      // the text content of nodes up to the selection boundaries.
      // This is an approximation: we walk the rendered text nodes in document
      // order and accumulate lengths until we reach the start/end containers.
      function computeOffset(root: HTMLElement, targetNode: Node, targetOffset: number): number {
        let total = 0;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null = walker.nextNode();
        while (node) {
          if (node === targetNode) {
            return total + targetOffset;
          }
          total += (node.textContent ?? '').length;
          node = walker.nextNode();
        }
        return total + targetOffset;
      }

      const startOffset = computeOffset(container!, range.startContainer, range.startOffset);
      const endOffset = computeOffset(container!, range.endContainer, range.endOffset);

      if (endOffset <= startOffset) return;

      const rect = range.getBoundingClientRect();
      onTextSelected!({
        text: selectedText,
        startOffset,
        endOffset,
        rect,
      });
    }

    container.addEventListener('mouseup', handleMouseUp);
    return () => {
      container.removeEventListener('mouseup', handleMouseUp);
    };
  }, [onTextSelected]);

  // Suppress unused-variable warning when threads prop is not yet consumed
  // by a visual highlight layer (that is a future enhancement beyond this issue).
  void threads;

  // Attach delegated mouseover, click, and touch listeners for citation markers.
  // Touch events are handled separately so that tap interactions on mobile
  // PWA surfaces work without relying on the synthesised click event delay.
  // touchend calls preventDefault() to suppress the subsequent synthetic click
  // and avoid double-firing the callback on hybrid devices.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function getCitationId(target: EventTarget | null): string | undefined {
      if (!target) return undefined;
      const citation = (target as HTMLElement).closest('sup.wiki-citation');
      if (!citation) return undefined;
      return (citation as HTMLElement).dataset.citationId;
    }

    function handleMouseOver(event: MouseEvent) {
      const target = event.target as HTMLElement;
      const citation = target.closest('sup.wiki-citation');
      if (!citation) return;
      const citationId = (citation as HTMLElement).dataset.citationId;
      if (!citationId) return;
      const anchorRect = (citation as HTMLElement).getBoundingClientRect();
      fetchCitation(citationId, anchorRect);
    }

    function handleClick(event: MouseEvent) {
      const citationId = getCitationId(event.target);
      if (citationId && onCitationClick) {
        onCitationClick(citationId);
      }
    }

    function handleTouchEnd(event: TouchEvent) {
      const citationId = getCitationId(event.target);
      if (citationId) {
        event.preventDefault();
        if (onCitationClick) {
          onCitationClick(citationId);
        }
      }
    }

    container.addEventListener('mouseover', handleMouseOver);
    container.addEventListener('click', handleClick);
    container.addEventListener('touchend', handleTouchEnd, { passive: false });
    return () => {
      container.removeEventListener('mouseover', handleMouseOver);
      container.removeEventListener('click', handleClick);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [fetchCitation, onCitationClick]);

  return (
    <>
      <article
        ref={containerRef}
        className={['wiki-render', className].filter(Boolean).join(' ')}
        data-wiki-version-id={version.id}
        data-wiki-state={version.state}
        // DOMPurify-sanitised HTML — safe to inject.
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <CitationHoverPopover state={hoverState} onClose={closePopover} />
    </>
  );
}

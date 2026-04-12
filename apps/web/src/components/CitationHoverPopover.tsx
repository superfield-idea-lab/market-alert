/**
 * @file CitationHoverPopover.tsx
 *
 * Citation hover popover — Phase 4 wiki web UX (issue #49).
 *
 * Renders a small popover attached to a citation marker anchor in the wiki.
 * When the user hovers or clicks a `<sup class="wiki-citation">` element,
 * `WikiRender` calls the citation resolution API and passes the result here.
 *
 * ## Data flow
 *
 *   1. User hovers a citation marker in WikiRender.
 *   2. WikiRender calls GET /api/wiki/pages/:customerId/versions/:versionId/citations/:token.
 *   3. The API returns excerpt + resolved_name (resolved_name only for superusers).
 *   4. CitationHoverPopover renders the excerpt and optional resolved name.
 *
 * ## Unauthorised callers
 *
 * Non-superusers see the excerpt (CorpusChunk text) but the `resolved_name`
 * field is `null`. The popover omits the sender line in that case.
 *
 * ## Position
 *
 * The popover is absolutely-positioned relative to the nearest positioned
 * ancestor. The caller provides the anchor rect so the popover can orient
 * itself correctly within the viewport.
 *
 * References:
 * - docs/implementation-plan-v1.md §Phase 4 — Wiki web UX
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/49
 */

import React, { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CitationResolution {
  token: string;
  entity_id: string;
  excerpt: string | null;
  source_id: string | null;
  /** Real sender/speaker name — null when caller lacks superuser role. */
  resolved_name: string | null;
}

export type CitationHoverState =
  | { status: 'idle' }
  | { status: 'loading'; citationId: string; anchorRect: DOMRect }
  | { status: 'loaded'; citationId: string; anchorRect: DOMRect; resolution: CitationResolution }
  | { status: 'error'; citationId: string; anchorRect: DOMRect; message: string }
  | { status: 'unauthorized'; citationId: string; anchorRect: DOMRect };

export interface CitationHoverPopoverProps {
  state: CitationHoverState;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * CitationHoverPopover
 *
 * Renders a positioned popover for the current hover state. Returns null when
 * idle so no DOM nodes are inserted while the user is not hovering.
 */
export function CitationHoverPopover({
  state,
  onClose,
}: CitationHoverPopoverProps): React.ReactElement | null {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on Escape key.
  useEffect(() => {
    if (state.status === 'idle') return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.status, onClose]);

  if (state.status === 'idle') return null;

  // Position the popover below the anchor element, clamped to the viewport.
  const anchorRect = state.anchorRect;
  const top = anchorRect.bottom + window.scrollY + 6;
  const left = Math.min(
    anchorRect.left + window.scrollX,
    window.innerWidth - 280, // keep within viewport
  );

  return (
    <div
      ref={popoverRef}
      role="tooltip"
      data-testid="citation-hover-popover"
      data-citation-id={state.citationId}
      style={{ top, left, position: 'absolute', zIndex: 50, width: '17.5rem' }}
      className="rounded-lg border border-zinc-200 bg-white shadow-lg text-sm"
      onMouseLeave={onClose}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-100">
        <span className="font-medium text-zinc-700 text-xs uppercase tracking-wide">
          Source citation
        </span>
        <button
          type="button"
          aria-label="Close citation popover"
          onClick={onClose}
          className="text-zinc-400 hover:text-zinc-600 transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="px-3 py-3 space-y-2">
        {state.status === 'loading' && (
          <p className="text-zinc-400 italic text-xs" data-testid="citation-popover-loading">
            Loading…
          </p>
        )}

        {state.status === 'error' && (
          <p className="text-red-500 text-xs" data-testid="citation-popover-error">
            {state.message}
          </p>
        )}

        {state.status === 'unauthorized' && (
          <p className="text-zinc-400 text-xs" data-testid="citation-popover-unauthorized">
            You do not have permission to view this citation source.
          </p>
        )}

        {state.status === 'loaded' && (
          <>
            {state.resolution.resolved_name && (
              <div data-testid="citation-popover-resolved-name">
                <span className="text-xs font-medium text-zinc-500">Sender / speaker: </span>
                <span className="text-xs text-zinc-800">{state.resolution.resolved_name}</span>
              </div>
            )}

            {state.resolution.excerpt ? (
              <blockquote
                className="text-xs text-zinc-700 italic border-l-2 border-zinc-200 pl-2"
                data-testid="citation-popover-excerpt"
              >
                {state.resolution.excerpt}
              </blockquote>
            ) : (
              <p className="text-zinc-400 text-xs italic" data-testid="citation-popover-no-excerpt">
                No excerpt available.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

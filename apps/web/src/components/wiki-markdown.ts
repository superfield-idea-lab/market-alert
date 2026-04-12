/**
 * @file wiki-markdown.ts
 *
 * Markdown-to-safe-HTML pipeline for wiki page versions.
 *
 * ## Pipeline
 *
 * 1. Parse markdown with `marked` (synchronous, no async extensions).
 * 2. Sanitise the raw HTML with DOMPurify, stripping all script/event-handler
 *    injection while preserving the structural tags needed for rich wiki content.
 * 3. Post-process citation markers (`[^citation-<id>]`) into `<sup>` elements
 *    with `data-citation-id` attributes so callers can attach interaction handlers.
 *
 * ## Citation marker convention
 *
 * The autolearn worker emits citation markers in the format `[^citation-<id>]`
 * inline within the markdown body (not as footnote definitions). The pipeline
 * converts each occurrence into:
 *
 *   <sup class="wiki-citation" data-citation-id="<id>">[<id>]</sup>
 *
 * Callers receive these as interactive targets via the `onCitationClick` prop on
 * `<WikiRender>`. The citation hover UI is a Phase 4 follow-on.
 *
 * ## Security
 *
 * DOMPurify is configured with an explicit `ALLOWED_TAGS` and `ALLOWED_ATTR`
 * allowlist. The allowlist permits the structural tags required for wiki prose
 * plus the `wiki-citation` `<sup>` elements emitted by the citation step.
 * `ADD_ATTR` adds `data-citation-id` to DOMPurify's allowed-attribute set.
 *
 * References:
 * - docs/implementation-plan-v1.md §Phase 4 — Wiki web UX
 * - @see https://github.com/superfield-ai/superfield-kb-demo/issues/46
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ---------------------------------------------------------------------------
// DOMPurify configuration
// ---------------------------------------------------------------------------

/**
 * Structural HTML tags that are safe in wiki prose.
 *
 * The set is intentionally narrow: we allow rich formatting but exclude
 * interactive elements (`<form>`, `<input>`, `<button>`) and embedding tags
 * (`<iframe>`, `<object>`, `<embed>`).
 */
const WIKI_ALLOWED_TAGS = [
  // Headings
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  // Block prose
  'p',
  'blockquote',
  'pre',
  'code',
  'hr',
  'br',
  // Lists
  'ul',
  'ol',
  'li',
  // Inline prose
  'strong',
  'em',
  'b',
  'i',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sup',
  'sub',
  'span',
  // Links
  'a',
  // Media (images only — no audio/video/iframe)
  'img',
  // Tables
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  // Misc
  'div',
  'details',
  'summary',
];

const WIKI_ALLOWED_ATTR = [
  'href',
  'title',
  'alt',
  'src',
  'width',
  'height',
  'class',
  'id',
  'target',
  'rel',
  // Citation hook — DOMPurify strips data-* by default; ADD_ATTR below re-adds it.
  'data-citation-id',
];

// ---------------------------------------------------------------------------
// Citation marker regex
// ---------------------------------------------------------------------------

/**
 * Matches inline citation markers of the form `[^citation-<id>]` where `<id>`
 * is one or more word characters (`\w+`).
 *
 * The regex runs on the **HTML** string produced by marked, not on the raw
 * markdown, because marked may have already wrapped surrounding content in
 * paragraphs. The marker itself is left verbatim by marked (it only processes
 * full footnote definitions, not bare `[^…]` references when no definition
 * exists).
 */
const CITATION_MARKER_RE = /\[[\^]citation-(\w+)\]/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A citation marker extracted from the rendered wiki HTML.
 */
export interface CitationMarker {
  /** The raw citation identifier, e.g. `"abc123"`. */
  id: string;
}

/**
 * Result of `renderWikiMarkdown`.
 */
export interface WikiRenderResult {
  /** Sanitised HTML string — safe to inject via `dangerouslySetInnerHTML`. */
  html: string;
  /** All citation markers found in the content, in document order. */
  citations: CitationMarker[];
}

/**
 * Convert a wiki page version's markdown body to sanitised HTML.
 *
 * This is the **only** markdown renderer that should be used for wiki content
 * in the web app. Do not reach for `marked` or `DOMPurify` directly.
 *
 * @param markdown - Raw markdown string from `WikiPageVersion.content`.
 * @returns `{ html, citations }` — safe HTML and extracted citation markers.
 */
export function renderWikiMarkdown(markdown: string): WikiRenderResult {
  // Step 1: parse markdown → raw HTML (synchronous).
  const rawHtml = marked.parse(markdown, { async: false }) as string;

  // Step 2: collect citation marker IDs before sanitisation (the `<sup>` we are
  // about to insert carries `data-citation-id` — DOMPurify would strip it unless
  // we add it via ADD_ATTR, but we collect the list here from the raw markdown
  // matches for correctness regardless of sanitiser configuration).
  const citations: CitationMarker[] = [];
  const withCitations = rawHtml.replace(CITATION_MARKER_RE, (_match, id: string) => {
    citations.push({ id });
    return `<sup class="wiki-citation" data-citation-id="${id}">[${id}]</sup>`;
  });

  // Step 3: sanitise — strip scripts, event handlers, and anything not in the
  // allowlist while preserving the `data-citation-id` attribute we just injected.
  const html = DOMPurify.sanitize(withCitations, {
    ALLOWED_TAGS: WIKI_ALLOWED_TAGS,
    ALLOWED_ATTR: WIKI_ALLOWED_ATTR,
    ADD_ATTR: ['data-citation-id'],
    // Forbid `javascript:` URI schemes in href/src even if somehow past the tag filter.
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
  });

  return { html, citations };
}

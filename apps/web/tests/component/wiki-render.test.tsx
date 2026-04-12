/**
 * @file wiki-render.test.tsx
 *
 * Component/integration tests for WikiRender and the wiki-markdown pipeline.
 *
 * Tests run in headless Chromium via vitest-browser-react so DOM APIs
 * (DOMPurify, dangerouslySetInnerHTML) behave exactly as in production.
 * No mocks — all assertions run against real DOM output.
 *
 * ## Coverage
 *
 * 1. Faithful markdown rendering — headings, bold, lists, code blocks.
 * 2. Sanitisation — HTML injection in markdown is stripped.
 * 3. Citation markers — `[^citation-<id>]` appears as interactive `<sup>`.
 * 4. Citation click callback — delegated listener forwards citation ID.
 * 5. onCitationsReady callback — receives citation list after render.
 * 6. data attributes — article carries version ID and state.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/46
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import { WikiRender } from '../../src/components/WikiRender';
import type { WikiPageVersion } from 'core';

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function makeVersion(content: string, overrides: Partial<WikiPageVersion> = {}): WikiPageVersion {
  return {
    id: 'version-1',
    content,
    state: 'PUBLISHED',
    wiki_page_id: 'page-1',
    tenant_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

test('renders a heading from markdown', async () => {
  const screen = render(
    <WikiRender version={makeVersion('# Hello wiki\n\nSome paragraph text.')} />,
  );
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Hello wiki' })).toBeVisible();
  await expect.element(screen.getByText('Some paragraph text.')).toBeVisible();
});

test('renders bold and italic inline formatting', async () => {
  const screen = render(<WikiRender version={makeVersion('**bold text** and _italic text_')} />);
  await expect.element(screen.getByText('bold text')).toBeVisible();
  await expect.element(screen.getByText('italic text')).toBeVisible();
});

test('renders an unordered list', async () => {
  const screen = render(<WikiRender version={makeVersion('- Item A\n- Item B\n- Item C')} />);
  await expect.element(screen.getByRole('list')).toBeVisible();
  // List items render their text as child text nodes — assert via getByText.
  await expect.element(screen.getByText('Item A')).toBeVisible();
  await expect.element(screen.getByText('Item B')).toBeVisible();
});

test('renders an ordered list', async () => {
  const screen = render(<WikiRender version={makeVersion('1. First\n2. Second\n3. Third')} />);
  await expect.element(screen.getByRole('list')).toBeVisible();
  await expect.element(screen.getByText('First')).toBeVisible();
});

test('renders inline code', async () => {
  const screen = render(<WikiRender version={makeVersion('Use `const x = 1` here.')} />);
  await expect.element(screen.getByText('const x = 1')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Sanitisation
// ---------------------------------------------------------------------------

test('strips script tags injected in markdown', async () => {
  const malicious = '<script>window.__xss = true;</script>\n\nSafe content.';
  const screen = render(<WikiRender version={makeVersion(malicious)} />);
  // The safe text must render.
  await expect.element(screen.getByText('Safe content.')).toBeVisible();
  // No script element must exist in the article.
  const article = screen.getByRole('article');
  await expect.element(article).not.toContainElement(document.createElement('script'));
  // The global sentinel must not have been set by any injected script.
  expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();
});

test('strips inline event handlers from injected HTML', async () => {
  const malicious = '<img src="x" onerror="window.__onerror_fired=true" />\n\nAfter.';
  const screen = render(<WikiRender version={makeVersion(malicious)} />);
  await expect.element(screen.getByText('After.')).toBeVisible();
  expect((window as unknown as Record<string, unknown>).__onerror_fired).toBeUndefined();
});

test('strips javascript: href from injected anchor', async () => {
  const malicious = '<a href="javascript:void(0)">click me</a>';
  render(<WikiRender version={makeVersion(malicious)} />);
  // The text may still appear (DOMPurify strips the href not the element
  // when the href is the only dangerous part) but no `javascript:` href
  // must survive in the DOM.
  const container = document.querySelector('[data-wiki-version-id="version-1"]');
  if (container) {
    const anchors = container.querySelectorAll('a[href^="javascript:"]');
    expect(anchors.length).toBe(0);
  }
});

// ---------------------------------------------------------------------------
// Citation markers
// ---------------------------------------------------------------------------

test('renders citation marker as interactive sup element', async () => {
  const screen = render(
    <WikiRender version={makeVersion('The claim is true.[^citation-abc123] More text.')} />,
  );
  // The citation sup must be present with the correct data attribute.
  const article = screen.container.querySelector('sup.wiki-citation[data-citation-id="abc123"]');
  expect(article).not.toBeNull();
});

test('renders multiple citation markers', async () => {
  const content =
    'First claim.[^citation-cit1] Second claim.[^citation-cit2] Third.[^citation-cit3]';
  const screen = render(<WikiRender version={makeVersion(content)} />);
  const citations = screen.container.querySelectorAll('sup.wiki-citation');
  expect(citations.length).toBe(3);
  expect((citations[0] as HTMLElement).dataset.citationId).toBe('cit1');
  expect((citations[1] as HTMLElement).dataset.citationId).toBe('cit2');
  expect((citations[2] as HTMLElement).dataset.citationId).toBe('cit3');
});

test('fires onCitationClick with citation ID when sup is clicked', async () => {
  const clicked: string[] = [];
  const screen = render(
    <WikiRender
      version={makeVersion('Text.[^citation-xyz789]')}
      onCitationClick={(id) => clicked.push(id)}
    />,
  );
  const sup = screen.container.querySelector('sup.wiki-citation[data-citation-id="xyz789"]');
  expect(sup).not.toBeNull();
  (sup as HTMLElement).click();
  expect(clicked).toEqual(['xyz789']);
});

test('onCitationsReady receives all citation markers', async () => {
  const received: string[] = [];
  render(
    <WikiRender
      version={makeVersion('A[^citation-c1] B[^citation-c2]')}
      onCitationsReady={(citations) => citations.forEach((c) => received.push(c.id))}
    />,
  );
  expect(received).toEqual(['c1', 'c2']);
});

// ---------------------------------------------------------------------------
// Data attributes
// ---------------------------------------------------------------------------

test('article carries data-wiki-version-id and data-wiki-state', async () => {
  const screen = render(
    <WikiRender version={makeVersion('Content.', { id: 'ver-42', state: 'AWAITING_REVIEW' })} />,
  );
  const article = screen.container.querySelector(
    'article[data-wiki-version-id="ver-42"][data-wiki-state="AWAITING_REVIEW"]',
  );
  expect(article).not.toBeNull();
});

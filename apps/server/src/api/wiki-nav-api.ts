/**
 * @file wiki-nav-api.ts
 *
 * Researcher-facing wiki navigation API — issue #77.
 *
 * ## Routes
 *
 *   GET  /api/wiki-nav/pages
 *     Query: tenant_id, subject_type? (optional filter), q? (search term)
 *     Returns: { pages: Array<{ id, subject_type, subject_id, currently_published_version_id,
 *                              open_debate_count, created_at, updated_at }> }
 *     Browses all wiki pages for a tenant. Optionally filtered by subject_type
 *     and searched by subject_id prefix.
 *
 *   GET  /api/wiki-nav/pages/:wiki_page_id
 *     Returns: { page, current_version, citations }
 *     Drill-in view: fetches the currently published version body and its
 *     citation edges (cites to confirmed_facts and corpus_chunks).
 *     Includes open debate count for the page.
 *
 *   GET  /api/wiki-nav/pages/:wiki_page_id/versions
 *     Returns: { versions: Array<{ id, status, created_at, updated_at }> }
 *     Lists all indexed versions for a wiki page (version history navigation).
 *     Prior versions remain navigable for replay.
 *
 *   GET  /api/wiki-nav/pages/:wiki_page_id/versions/:version_id
 *     Returns: { version, citations }
 *     Fetches a specific (possibly prior) version and its citations.
 *
 * ## Authentication
 *
 * Bearer token auth via WIKI_REBUILD_TEST_TOKEN in TEST_MODE.
 * All routes are scoped to the tenant_id in the query or derived from the page.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §9 — researcher navigates the wiki.
 * - docs/implementation-plan.md Phase 4 — wiki navigation UI.
 * - packages/db/wiki-rebuild-store.ts — wiki_pages / wiki_page_versions_mkt / wiki_page_cites.
 * - apps/web/src/pages/wiki-nav.tsx — frontend page.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/77
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import { getCitesEdges } from 'db/wiki-rebuild-store';
import { listOpenDebatesForPage } from 'db/wiki-debate-store';

// ---------------------------------------------------------------------------
// Auth helper (mirrors wiki-rebuild-api.ts pattern)
// ---------------------------------------------------------------------------

function checkBearer(req: Request): string | null {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim();
}

function isAuthorized(token: string | null): boolean {
  if (!token) return false;
  const testMode = process.env.TEST_MODE === 'true';
  const expectedToken = process.env.WIKI_REBUILD_TEST_TOKEN ?? '';
  if (testMode) return token === expectedToken && expectedToken.length > 0;
  // Production: TODO replace with signed JWT verification (follow-on).
  return false;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WikiPageSummaryRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  currently_published_version_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type WikiPageVersionSummaryRow = {
  id: string;
  wiki_page_id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  body_ciphertext: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle all /api/wiki-nav/* routes.
 *
 * Returns null when the pathname does not match so the caller can fall through.
 */
export async function handleWikiNavApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/wiki-nav')) return null;
  if (req.method !== 'GET') return null;

  const json = makeJson({});
  const token = checkBearer(req);

  if (!isAuthorized(token)) return json({ error: 'Unauthorized' }, 401);

  const { sql } = appState;

  // ── GET /api/wiki-nav/pages ────────────────────────────────────────────────
  if (url.pathname === '/api/wiki-nav/pages') {
    const tenant_id = url.searchParams.get('tenant_id') ?? '';
    const subject_type = url.searchParams.get('subject_type');
    const q = url.searchParams.get('q');

    if (!tenant_id) {
      return json({ error: 'tenant_id query param is required' }, 400);
    }

    let pages: WikiPageSummaryRow[];

    if (subject_type && q) {
      pages = await sql<WikiPageSummaryRow[]>`
        SELECT id, tenant_id, subject_type, subject_id,
               currently_published_version_id, created_at, updated_at
        FROM wiki_pages
        WHERE tenant_id    = ${tenant_id}
          AND subject_type = ${subject_type}
          AND subject_id   ILIKE ${`${q}%`}
        ORDER BY subject_id ASC
        LIMIT 100
      `;
    } else if (subject_type) {
      pages = await sql<WikiPageSummaryRow[]>`
        SELECT id, tenant_id, subject_type, subject_id,
               currently_published_version_id, created_at, updated_at
        FROM wiki_pages
        WHERE tenant_id    = ${tenant_id}
          AND subject_type = ${subject_type}
        ORDER BY subject_id ASC
        LIMIT 100
      `;
    } else if (q) {
      pages = await sql<WikiPageSummaryRow[]>`
        SELECT id, tenant_id, subject_type, subject_id,
               currently_published_version_id, created_at, updated_at
        FROM wiki_pages
        WHERE tenant_id  = ${tenant_id}
          AND subject_id ILIKE ${`${q}%`}
        ORDER BY subject_type ASC, subject_id ASC
        LIMIT 100
      `;
    } else {
      pages = await sql<WikiPageSummaryRow[]>`
        SELECT id, tenant_id, subject_type, subject_id,
               currently_published_version_id, created_at, updated_at
        FROM wiki_pages
        WHERE tenant_id = ${tenant_id}
        ORDER BY subject_type ASC, subject_id ASC
        LIMIT 100
      `;
    }

    // Attach open debate counts for each page.
    const pagesWithCounts = await Promise.all(
      pages.map(async (page) => {
        const debates = await listOpenDebatesForPage(sql, page.id);
        return {
          id: page.id,
          tenant_id: page.tenant_id,
          subject_type: page.subject_type,
          subject_id: page.subject_id,
          currently_published_version_id: page.currently_published_version_id,
          open_debate_count: debates.length,
          created_at:
            page.created_at instanceof Date
              ? page.created_at.toISOString()
              : String(page.created_at),
          updated_at:
            page.updated_at instanceof Date
              ? page.updated_at.toISOString()
              : String(page.updated_at),
        };
      }),
    );

    return json({ pages: pagesWithCounts });
  }

  // ── GET /api/wiki-nav/pages/:wiki_page_id/versions ────────────────────────
  const versionsMatch = url.pathname.match(/^\/api\/wiki-nav\/pages\/([^/]+)\/versions$/);
  if (versionsMatch) {
    const wiki_page_id = versionsMatch[1]!;

    // Return all indexed versions for version history navigation.
    const versions = await sql<WikiPageVersionSummaryRow[]>`
      SELECT id, wiki_page_id, tenant_id, subject_type, subject_id,
             status, created_at, updated_at
      FROM wiki_page_versions_mkt
      WHERE wiki_page_id = ${wiki_page_id}
        AND status = 'indexed'
      ORDER BY created_at DESC
    `;

    return json({
      versions: versions.map((v) => ({
        id: v.id,
        wiki_page_id: v.wiki_page_id,
        subject_type: v.subject_type,
        subject_id: v.subject_id,
        status: v.status,
        created_at:
          v.created_at instanceof Date ? v.created_at.toISOString() : String(v.created_at),
        updated_at:
          v.updated_at instanceof Date ? v.updated_at.toISOString() : String(v.updated_at),
      })),
    });
  }

  // ── GET /api/wiki-nav/pages/:wiki_page_id/versions/:version_id ──────────
  const versionDetailMatch = url.pathname.match(
    /^\/api\/wiki-nav\/pages\/([^/]+)\/versions\/([^/]+)$/,
  );
  if (versionDetailMatch) {
    const wiki_page_id = versionDetailMatch[1]!;
    const version_id = versionDetailMatch[2]!;

    const versions = await sql<WikiPageVersionSummaryRow[]>`
      SELECT id, wiki_page_id, tenant_id, subject_type, subject_id,
             body_ciphertext, status, created_at, updated_at
      FROM wiki_page_versions_mkt
      WHERE id          = ${version_id}
        AND wiki_page_id = ${wiki_page_id}
        AND status = 'indexed'
    `;

    if (versions.length === 0) return json({ error: 'Version not found' }, 404);

    const version = versions[0]!;
    const citations = await getCitesEdges(sql, version_id);

    return json({
      version: {
        id: version.id,
        wiki_page_id: version.wiki_page_id,
        subject_type: version.subject_type,
        subject_id: version.subject_id,
        body_ciphertext: version.body_ciphertext,
        status: version.status,
        created_at:
          version.created_at instanceof Date
            ? version.created_at.toISOString()
            : String(version.created_at),
        updated_at:
          version.updated_at instanceof Date
            ? version.updated_at.toISOString()
            : String(version.updated_at),
      },
      citations: citations.map((c) => ({
        id: c.id,
        target_id: c.target_id,
        target_type: c.target_type,
        created_at:
          c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
      })),
    });
  }

  // ── GET /api/wiki-nav/pages/:wiki_page_id ──────────────────────────────────
  const pageDetailMatch = url.pathname.match(/^\/api\/wiki-nav\/pages\/([^/]+)$/);
  if (pageDetailMatch) {
    const wiki_page_id = pageDetailMatch[1]!;

    // Fetch the wiki_page row.
    const pages = await sql<WikiPageSummaryRow[]>`
      SELECT id, tenant_id, subject_type, subject_id,
             currently_published_version_id, created_at, updated_at
      FROM wiki_pages
      WHERE id = ${wiki_page_id}
    `;

    if (pages.length === 0) return json({ error: 'Wiki page not found' }, 404);

    const page = pages[0]!;

    // Fetch the currently published version (if any).
    let currentVersion: WikiPageVersionSummaryRow | null = null;
    let citations: Array<{
      id: string;
      target_id: string;
      target_type: string;
      created_at: string;
    }> = [];

    if (page.currently_published_version_id) {
      const versions = await sql<WikiPageVersionSummaryRow[]>`
        SELECT id, wiki_page_id, tenant_id, subject_type, subject_id,
               body_ciphertext, status, created_at, updated_at
        FROM wiki_page_versions_mkt
        WHERE id = ${page.currently_published_version_id}
      `;
      if (versions.length > 0) {
        currentVersion = versions[0]!;
        const citesRows = await getCitesEdges(sql, page.currently_published_version_id);
        citations = citesRows.map((c) => ({
          id: c.id,
          target_id: c.target_id,
          target_type: c.target_type,
          created_at:
            c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at),
        }));
      }
    }

    // Fetch open debate count.
    const debates = await listOpenDebatesForPage(sql, wiki_page_id);

    return json({
      page: {
        id: page.id,
        tenant_id: page.tenant_id,
        subject_type: page.subject_type,
        subject_id: page.subject_id,
        currently_published_version_id: page.currently_published_version_id,
        open_debate_count: debates.length,
        created_at:
          page.created_at instanceof Date ? page.created_at.toISOString() : String(page.created_at),
        updated_at:
          page.updated_at instanceof Date ? page.updated_at.toISOString() : String(page.updated_at),
      },
      current_version: currentVersion
        ? {
            id: currentVersion.id,
            subject_type: currentVersion.subject_type,
            subject_id: currentVersion.subject_id,
            body_ciphertext: currentVersion.body_ciphertext,
            status: currentVersion.status,
            created_at:
              currentVersion.created_at instanceof Date
                ? currentVersion.created_at.toISOString()
                : String(currentVersion.created_at),
            updated_at:
              currentVersion.updated_at instanceof Date
                ? currentVersion.updated_at.toISOString()
                : String(currentVersion.updated_at),
          }
        : null,
      citations,
    });
  }

  return null;
}

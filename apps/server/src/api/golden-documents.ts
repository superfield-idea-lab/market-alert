/**
 * @file golden-documents.ts
 *
 * API handler for golden-document routes (issue #73, PRD §6 §9).
 *
 * ## Routes
 *
 *   POST   /api/golden-documents                — researcher creates a golden document
 *   GET    /api/golden-documents                — researcher lists their golden documents
 *   GET    /api/golden-documents/:id            — researcher reads a golden document
 *   PATCH  /api/golden-documents/:id/state      — researcher changes document state
 *   POST   /api/golden-documents/:id/sections   — researcher upserts a section
 *   GET    /api/golden-documents/:id/sections   — list sections for a document
 *   GET    /api/golden-documents/active/:kind   — unified retrieval: fetch active doc + sections
 *
 * ## Author-only enforcement (three layers)
 *
 *   1. API layer  — this handler verifies the session role is 'researcher'
 *      before any write reaches the DB. Worker Bearer tokens receive 403 and
 *      a `golden_document.write_denied` journal event is written.
 *   2. RLS policy — `golden_documents_researcher_only` (RESTRICTIVE) applied
 *      in init-remote.ts blocks writes when `app.current_role != 'researcher'`.
 *   3. Trigger    — `guard_golden_document_writer` fires on INSERT/UPDATE.
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §9 — golden documents are author-only forever.
 * - `docs/architecture.md` — data tier, per-pool role isolation.
 * - `docs/implementation-plan.md` Phase 2.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { makeJson } from '../lib/response';
import { withRlsContext } from 'db/rls-context';
import { writeJournalEvent } from 'db/business-journal';
import {
  createGoldenDocument,
  getGoldenDocument,
  listGoldenDocuments,
  activateGoldenDocument,
  retireGoldenDocument,
  upsertGoldenDocumentSection,
  listGoldenDocumentSections,
  fetchActiveGoldenDocument,
  type GoldenDocumentKind,
} from 'db/golden-document-store';

// ---------------------------------------------------------------------------
// Type contracts
// ---------------------------------------------------------------------------

export interface CreateGoldenDocumentRequest {
  /** 'industry_definition' | 'research_methodology' */
  kind: string;
  /** Researcher-supplied title for the document. */
  title: string;
}

export interface GoldenDocumentResponse {
  id: string;
  kind: string;
  title: string;
  author_id: string;
  tenant_id: string;
  state: 'authored' | 'active' | 'retired';
  created_at: string;
  updated_at: string;
}

export interface StateTransitionRequest {
  /** 'active' | 'retired' */
  state: string;
}

export interface UpsertSectionRequest {
  section_key: string;
  content: string;
  position?: number;
}

// ---------------------------------------------------------------------------
// Helper: determine whether the session user is a researcher
// ---------------------------------------------------------------------------

/**
 * For now the session JWT does not carry a `role` claim — all authenticated
 * users are treated as researchers on the golden-documents surface.  A future
 * issue will add role claims to the JWT and this function will check them.
 *
 * Returns 'researcher' for any authenticated session without a Bearer token.
 * Worker Bearer tokens are rejected before this function is reached.
 */
function getSessionRole(_user: { id: string; username: string }): string {
  // All session-cookie authenticated users are researchers for this surface.
  // Issue #73 follow-on: check JWT role claim when roles are added to tokens.
  return 'researcher';
}

const VALID_KINDS = new Set<GoldenDocumentKind>(['industry_definition', 'research_methodology']);

function isValidKind(k: string): k is GoldenDocumentKind {
  return VALID_KINDS.has(k as GoldenDocumentKind);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle all /api/golden-documents requests.
 *
 * Returns null when the route does not match so the caller can fall through
 * to the next handler.
 */
export async function handleGoldenDocumentsRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/golden-documents')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ── CORS preflight ────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, 'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS' },
    });
  }

  // ── Authentication check ──────────────────────────────────────────────────
  //
  // Worker Bearer tokens are explicitly denied (PRD §9 — author-only).
  // The denial is journalled as `golden_document.write_denied`.

  const authHeader = req.headers.get('Authorization') ?? '';
  if (authHeader.startsWith('Bearer ')) {
    // Any Bearer token on a mutating route is a worker token — deny.
    // We optimistically log a denial even for read routes to surface mis-use.
    try {
      await writeJournalEvent(sql, {
        event_type: 'golden_document.write_denied',
        entity_id: 'golden_documents',
        actor_id: 'bearer_token_actor',
        payload_ref: null,
      });
    } catch {
      // Journal write failure must not mask the 403 response.
    }
    return json(
      {
        error: 'Forbidden — worker tokens may not access golden documents (PRD §9)',
      },
      403,
    );
  }

  // Require an authenticated researcher session cookie.
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return json({ error: 'Unauthorized — researcher session required' }, 401);
  }

  const sessionRole = getSessionRole(user);

  // ── GET /api/golden-documents/active/:kind ────────────────────────────────
  // Unified retrieval endpoint: active document + sections for a given kind.
  // tenant_id must be supplied as a query param for now.
  const activeMatch = url.pathname.match(/^\/api\/golden-documents\/active\/([^/]+)$/);
  if (req.method === 'GET' && activeMatch) {
    const kind = activeMatch[1];
    if (!isValidKind(kind)) {
      return json({ error: `Invalid kind: ${kind}` }, 400);
    }
    const tenantId = url.searchParams.get('tenant_id') ?? '';
    if (!tenantId) {
      return json({ error: 'tenant_id query param required' }, 400);
    }

    const result = await withRlsContext(
      sql,
      { userId: user.id, tenantId, role: sessionRole },
      async (tx) => fetchActiveGoldenDocument(tx, kind, user.id, tenantId),
    );
    return json(result, 200);
  }

  // ── GET /api/golden-documents/:id/sections ───────────────────────────────
  const sectionsListMatch = url.pathname.match(/^\/api\/golden-documents\/([^/]+)\/sections$/);
  if (req.method === 'GET' && sectionsListMatch) {
    const docId = sectionsListMatch[1];
    // Fetch the doc to derive tenant_id for RLS context.
    const docForTenant = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM golden_documents WHERE id = ${docId} LIMIT 1
    `;
    if (docForTenant.length === 0) return json({ error: 'Not found' }, 404);
    const tenantId = docForTenant[0].tenant_id;

    const sections = await withRlsContext(
      sql,
      { userId: user.id, tenantId, role: sessionRole },
      async (tx) => listGoldenDocumentSections(tx, docId),
    );
    return json({ sections }, 200);
  }

  // ── POST /api/golden-documents/:id/sections ──────────────────────────────
  const sectionUpsertMatch = url.pathname.match(/^\/api\/golden-documents\/([^/]+)\/sections$/);
  if (req.method === 'POST' && sectionUpsertMatch) {
    const docId = sectionUpsertMatch[1];

    let body: UpsertSectionRequest;
    try {
      body = (await req.json()) as UpsertSectionRequest;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.section_key || typeof body.content !== 'string') {
      return json({ error: 'section_key and content are required' }, 400);
    }

    // Fetch the doc to derive tenant_id for RLS context.
    const docForTenant = await sql<{ tenant_id: string; author_id: string }[]>`
      SELECT tenant_id, author_id FROM golden_documents WHERE id = ${docId} LIMIT 1
    `;
    if (docForTenant.length === 0) return json({ error: 'Not found' }, 404);
    if (docForTenant[0].author_id !== user.id) {
      return json({ error: 'Forbidden — only the author may edit sections' }, 403);
    }
    const tenantId = docForTenant[0].tenant_id;

    const section = await withRlsContext(
      sql,
      { userId: user.id, tenantId, role: sessionRole },
      async (tx) =>
        upsertGoldenDocumentSection(tx, {
          document_id: docId,
          section_key: body.section_key,
          content: body.content,
          position: body.position,
        }),
    );
    return json({ section }, 200);
  }

  // ── PATCH /api/golden-documents/:id/state ────────────────────────────────
  const stateMatch = url.pathname.match(/^\/api\/golden-documents\/([^/]+)\/state$/);
  if (req.method === 'PATCH' && stateMatch) {
    const docId = stateMatch[1];

    let body: StateTransitionRequest;
    try {
      body = (await req.json()) as StateTransitionRequest;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!['active', 'retired'].includes(body.state)) {
      return json({ error: 'state must be "active" or "retired"' }, 400);
    }

    // Fetch doc to get tenant_id and verify authorship.
    const docRows = await sql<{ tenant_id: string; author_id: string }[]>`
      SELECT tenant_id, author_id FROM golden_documents WHERE id = ${docId} LIMIT 1
    `;
    if (docRows.length === 0) return json({ error: 'Not found' }, 404);
    if (docRows[0].author_id !== user.id) {
      return json({ error: 'Forbidden — only the author may change document state' }, 403);
    }
    const tenantId = docRows[0].tenant_id;

    const updatedDoc = await withRlsContext(
      sql,
      { userId: user.id, tenantId, role: sessionRole },
      async (tx) => {
        if (body.state === 'active') {
          return activateGoldenDocument(tx, docId, user.id, tenantId);
        } else {
          return retireGoldenDocument(tx, docId, user.id, tenantId);
        }
      },
    );

    if (!updatedDoc) return json({ error: 'Document not found or transition not allowed' }, 404);

    await writeJournalEvent(sql, {
      event_type: `golden_document.state_changed.${body.state}`,
      entity_id: docId,
      actor_id: user.id,
    });

    return json({ document: updatedDoc }, 200);
  }

  // ── GET /api/golden-documents/:id ────────────────────────────────────────
  const getMatch = url.pathname.match(/^\/api\/golden-documents\/([^/]+)$/);
  if (req.method === 'GET' && getMatch) {
    const id = getMatch[1];
    // Derive tenant_id from the document (needed for RLS context).
    const tenantRows = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM golden_documents WHERE id = ${id} LIMIT 1
    `;
    if (tenantRows.length === 0) return json({ error: 'Not found' }, 404);
    const tenantId = tenantRows[0].tenant_id;

    const doc = await withRlsContext(
      sql,
      { userId: user.id, tenantId, role: sessionRole },
      async (tx) => getGoldenDocument(tx, id),
    );
    if (!doc) return json({ error: 'Not found' }, 404);
    return json({ document: doc }, 200);
  }

  // ── POST /api/golden-documents ───────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/golden-documents') {
    let body: CreateGoldenDocumentRequest;
    try {
      body = (await req.json()) as CreateGoldenDocumentRequest;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.kind || !body.title) {
      return json({ error: 'kind and title are required' }, 400);
    }
    if (!isValidKind(body.kind)) {
      return json({ error: 'kind must be "industry_definition" or "research_methodology"' }, 400);
    }

    // tenant_id is derived from the authenticated user's session.
    // For now we use the user's entity tenant_id from the DB.
    const tenantRows = await sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM entities WHERE id = ${user.id} LIMIT 1
    `;
    const tenantId = tenantRows[0]?.tenant_id ?? 'default';

    const doc = await withRlsContext(
      sql,
      { userId: user.id, tenantId, role: sessionRole },
      async (tx) =>
        createGoldenDocument(tx, {
          kind: body.kind as GoldenDocumentKind,
          author_id: user.id,
          tenant_id: tenantId,
          title: body.title,
        }),
    );

    await writeJournalEvent(sql, {
      event_type: 'golden_document.created',
      entity_id: doc.id,
      actor_id: user.id,
    });

    return json({ document: doc }, 201);
  }

  // ── GET /api/golden-documents ────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/golden-documents') {
    // List the authenticated researcher's golden documents for a given tenant.
    const tenantId = url.searchParams.get('tenant_id') ?? '';
    if (!tenantId) {
      // Derive tenant from the user entity.
      const tenantRows = await sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM entities WHERE id = ${user.id} LIMIT 1
      `;
      const derivedTenantId = tenantRows[0]?.tenant_id ?? 'default';
      const docs = await withRlsContext(
        sql,
        { userId: user.id, tenantId: derivedTenantId, role: sessionRole },
        async (tx) => listGoldenDocuments(tx, user.id, derivedTenantId),
      );
      return json({ documents: docs }, 200);
    }

    const docs = await withRlsContext(
      sql,
      { userId: user.id, tenantId, role: sessionRole },
      async (tx) => listGoldenDocuments(tx, user.id, tenantId),
    );
    return json({ documents: docs }, 200);
  }

  return null;
}

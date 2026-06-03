/**
 * @file source-scrape-api.ts
 *
 * Internal API handlers for the canonical-source scraping pipeline — Phase 3 (issue #75).
 *
 * ## Routes
 *
 *   GET  /internal/canonical-sources/:id           — fetch one canonical source by ID
 *   POST /internal/scrape/source-finding           — register a scraped finding (dedup by content_hash)
 *   GET  /internal/scrape/source-finding/:id       — fetch one source_finding by ID
 *   PATCH /internal/scrape/source-finding/:id/ingest     — mark finding ingested
 *   PATCH /internal/scrape/source-finding/:id/quarantine — mark finding quarantined
 *   POST /internal/scrape/corpus-chunk             — persist one corpus chunk
 *   GET  /internal/scrape/corpus-chunk/:id         — fetch one corpus chunk by ID
 *   POST /internal/scrape/confirmed-fact           — insert a confirmed fact (supersession chain)
 *   GET  /internal/scrape/confirmed-fact/current   — list current (non-superseded) facts
 *   POST /internal/scrape/quarantine               — quarantine a malformed payload
 *
 * ## Security
 *
 * Bearer token is validated against EDGAR_TEST_TOKEN in TEST_MODE.
 * Production will require a signed worker JWT (Phase 3 follow-on).
 *
 * ## Canonical docs
 *
 * - docs/architecture.md — SOURCE_SCRAPE, FINDING_INGEST, FACT_EXTRACT workers
 * - packages/db/mkt-knowledge-store.ts — DB store
 * - apps/worker/src/source-scrape-job.ts
 * - apps/worker/src/finding-ingest-job.ts
 * - apps/worker/src/fact-extract-job.ts
 * - tests/integration/source-scrape-ingest.spec.ts — integration tests
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/75
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import { getCanonicalSource } from 'db/canonical-source-store';
import {
  insertSourceFinding,
  getSourceFinding,
  markFindingIngested,
  markFindingQuarantined,
  insertConfirmedFact,
  listCurrentFacts,
  quarantinePayload,
  type InsertSourceFindingInput,
  type InsertConfirmedFactInput,
  type InsertEtlQuarantineInput,
} from 'db/mkt-knowledge-store';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function checkBearer(req: Request): string | null {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice('Bearer '.length).trim();
}

function isAuthorized(token: string | null): boolean {
  if (!token) return false;
  const testMode = process.env.TEST_MODE === 'true';
  const expectedToken = process.env.EDGAR_TEST_TOKEN ?? '';
  if (testMode) return token === expectedToken && expectedToken.length > 0;
  // Production: TODO replace with signed JWT verification.
  return false;
}

// ---------------------------------------------------------------------------
// corpus_chunks — simple in-db store (reuses schema.sql corpus_chunks table)
// ---------------------------------------------------------------------------

/**
 * Insert a corpus chunk row.
 * Reuses the existing corpus_chunks table from schema.sql (no embedding in this path).
 */
async function insertCorpusChunk(
  sql: AppState['sql'],
  input: {
    source_id: string;
    source_finding_id: string;
    tenant_id: string;
    content: string;
    chunk_index: number;
  },
): Promise<{
  id: string;
  source_id: string;
  tenant_id: string;
  content: string;
  chunk_index: number;
}> {
  // corpus_chunks table is conditionally created (pgvector guard). We try INSERT
  // but fall back gracefully if the table does not exist.
  const rows = await sql<
    {
      id: string;
      source_id: string | null;
      tenant_id: string;
      content: string;
      chunk_index: number;
    }[]
  >`
    INSERT INTO corpus_chunks (source_id, tenant_id, content, chunk_index)
    VALUES (${input.source_id}, ${input.tenant_id}, ${input.content}, ${input.chunk_index})
    RETURNING id, source_id, tenant_id, content, chunk_index
  `;
  const row = rows[0];
  if (!row) throw new Error('corpus_chunks: insert returned no row');
  return { ...row, source_id: row.source_id ?? input.source_id };
}

/**
 * Fetch one corpus_chunk by ID.
 */
async function getCorpusChunk(
  sql: AppState['sql'],
  id: string,
): Promise<{
  id: string;
  source_id: string | null;
  tenant_id: string;
  content: string;
  chunk_index: number;
} | null> {
  const rows = await sql<
    {
      id: string;
      source_id: string | null;
      tenant_id: string;
      content: string;
      chunk_index: number;
    }[]
  >`
    SELECT id, source_id, tenant_id, content, chunk_index
    FROM corpus_chunks
    WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Main handler dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle all /internal/canonical-sources/:id GET and /internal/scrape/* routes.
 *
 * Returns null when the request does not match any known route.
 */
export async function handleSourceScrapeApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const { sql } = appState;
  const json = makeJson({});

  // ── GET /internal/canonical-sources/:id ───────────────────────────────────
  const csMatch = url.pathname.match(/^\/internal\/canonical-sources\/([^/]+)$/);
  if (csMatch && req.method === 'GET') {
    const token = checkBearer(req);
    if (!isAuthorized(token)) return json({ error: 'Unauthorized' }, 401);
    const id = csMatch[1];
    const source = await getCanonicalSource(sql, id);
    if (!source) return json({ error: 'Not found' }, 404);
    return json(source);
  }

  // Only handle /internal/scrape/* from here on.
  if (!url.pathname.startsWith('/internal/scrape/')) return null;

  const token = checkBearer(req);
  if (!isAuthorized(token)) return json({ error: 'Unauthorized' }, 401);

  // ── POST /internal/scrape/source-finding ──────────────────────────────────
  if (url.pathname === '/internal/scrape/source-finding' && req.method === 'POST') {
    let body: Partial<InsertSourceFindingInput & { source_finding_id?: string }>;
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.canonical_source_id || !body.tenant_id || !body.content_hash || !body.raw_content) {
      return json(
        { error: 'canonical_source_id, tenant_id, content_hash, and raw_content are required' },
        400,
      );
    }

    const { row, created } = await insertSourceFinding(sql, {
      canonical_source_id: body.canonical_source_id,
      tenant_id: body.tenant_id,
      content_hash: body.content_hash,
      raw_content: body.raw_content,
      source_url: body.source_url ?? null,
    });

    return json({ created, finding: row }, created ? 201 : 200);
  }

  // ── GET /internal/scrape/source-finding/:id ───────────────────────────────
  const sfGetMatch = url.pathname.match(/^\/internal\/scrape\/source-finding\/([^/]+)$/);
  if (sfGetMatch && req.method === 'GET') {
    const id = sfGetMatch[1];
    const finding = await getSourceFinding(sql, id);
    if (!finding) return json({ error: 'Not found' }, 404);
    return json(finding);
  }

  // ── PATCH /internal/scrape/source-finding/:id/ingest ─────────────────────
  const sfIngestMatch = url.pathname.match(/^\/internal\/scrape\/source-finding\/([^/]+)\/ingest$/);
  if (sfIngestMatch && req.method === 'PATCH') {
    const id = sfIngestMatch[1];
    const updated = await markFindingIngested(sql, id);
    if (!updated) return json({ error: 'Not found or invalid transition' }, 404);
    return json({ finding: updated });
  }

  // ── PATCH /internal/scrape/source-finding/:id/quarantine ─────────────────
  const sfQuarantineMatch = url.pathname.match(
    /^\/internal\/scrape\/source-finding\/([^/]+)\/quarantine$/,
  );
  if (sfQuarantineMatch && req.method === 'PATCH') {
    const id = sfQuarantineMatch[1];
    const updated = await markFindingQuarantined(sql, id);
    if (!updated) return json({ error: 'Not found or invalid transition' }, 404);
    return json({ finding: updated });
  }

  // ── POST /internal/scrape/corpus-chunk ───────────────────────────────────
  if (url.pathname === '/internal/scrape/corpus-chunk' && req.method === 'POST') {
    let body: {
      source_id?: string;
      source_finding_id?: string;
      tenant_id?: string;
      content?: string;
      chunk_index?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.source_id || !body.tenant_id || !body.content || body.chunk_index === undefined) {
      return json({ error: 'source_id, tenant_id, content, and chunk_index are required' }, 400);
    }

    const chunk = await insertCorpusChunk(sql, {
      source_id: body.source_id,
      source_finding_id: body.source_finding_id ?? '',
      tenant_id: body.tenant_id,
      content: body.content,
      chunk_index: body.chunk_index,
    });

    return json({ chunk }, 201);
  }

  // ── GET /internal/scrape/corpus-chunk/:id ────────────────────────────────
  const ccGetMatch = url.pathname.match(/^\/internal\/scrape\/corpus-chunk\/([^/]+)$/);
  if (ccGetMatch && req.method === 'GET') {
    const id = ccGetMatch[1];
    const chunk = await getCorpusChunk(sql, id);
    if (!chunk) return json({ error: 'Not found' }, 404);
    return json(chunk);
  }

  // ── POST /internal/scrape/confirmed-fact ─────────────────────────────────
  if (url.pathname === '/internal/scrape/confirmed-fact' && req.method === 'POST') {
    let body: Partial<InsertConfirmedFactInput>;
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (
      !body.tenant_id ||
      !body.corpus_chunk_id ||
      !body.subject_entity_id ||
      !body.subject_entity_type ||
      !body.attribute ||
      !body.value
    ) {
      return json(
        {
          error:
            'tenant_id, corpus_chunk_id, subject_entity_id, subject_entity_type, attribute, and value are required',
        },
        400,
      );
    }

    const fact = await insertConfirmedFact(sql, {
      tenant_id: body.tenant_id,
      corpus_chunk_id: body.corpus_chunk_id,
      subject_entity_id: body.subject_entity_id,
      subject_entity_type: body.subject_entity_type,
      attribute: body.attribute,
      value: body.value,
      confidence: body.confidence ?? null,
      supersedes_fact_id: body.supersedes_fact_id ?? null,
    });

    return json({ fact }, 201);
  }

  // ── GET /internal/scrape/confirmed-fact/current ───────────────────────────
  if (url.pathname === '/internal/scrape/confirmed-fact/current' && req.method === 'GET') {
    const tenantId = url.searchParams.get('tenant_id');
    const subjectEntityId = url.searchParams.get('subject_entity_id');
    const attribute = url.searchParams.get('attribute');

    if (!tenantId || !subjectEntityId || !attribute) {
      return json({ error: 'tenant_id, subject_entity_id, and attribute are required' }, 400);
    }

    const facts = await listCurrentFacts(sql, tenantId, subjectEntityId, attribute);
    return json({ facts });
  }

  // ── POST /internal/scrape/quarantine ─────────────────────────────────────
  if (url.pathname === '/internal/scrape/quarantine' && req.method === 'POST') {
    let body: Partial<InsertEtlQuarantineInput>;
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.source || !body.raw_payload || !body.error_message) {
      return json({ error: 'source, raw_payload, and error_message are required' }, 400);
    }

    const row = await quarantinePayload(sql, {
      source: body.source,
      source_finding_id: body.source_finding_id ?? null,
      raw_payload: body.raw_payload,
      error_message: body.error_message,
    });

    return json({ quarantine: row }, 201);
  }

  return null;
}

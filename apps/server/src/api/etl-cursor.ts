/**
 * @file etl-cursor.ts
 *
 * Internal ETL cursor API — watermark read/write for the EDGAR ingestion worker.
 *
 * ## Endpoints
 *
 *   GET  /internal/etl/cursor/:source/:cursor_key
 *     Returns the current EtlCursorRow for (source, cursor_key).
 *     Returns 404 when no row exists (first run for this form type).
 *
 *   PUT  /internal/etl/cursor/:source/:cursor_key
 *     Upserts the watermark for (source, cursor_key).
 *     Body: { watermark_value: string, overlap_seconds?: number }
 *     Returns 200 with the resulting row.
 *
 * ## Security
 *
 * Bearer token from EDGAR_TEST_TOKEN (TEST_MODE=true) or a signed worker JWT
 * (production follow-on). Same auth model as corporate-action-ingestion.ts.
 *
 * ## Canonical docs
 *
 * - packages/db/etl-cursors.ts — data access
 * - apps/worker/src/edgar-ingest-job.ts — consumer
 * - docs/architecture.md — ingestion pipeline
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import { getEtlCursor, upsertEtlCursor } from 'db/etl-cursors';

// ---------------------------------------------------------------------------
// Auth helper (same pattern as corporate-action-ingestion.ts)
// ---------------------------------------------------------------------------

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('Authorization') ?? '';
  const tokenMatch = authHeader.match(/^Bearer (.+)$/);
  if (!tokenMatch) return false;
  const token = tokenMatch[1];

  if (process.env.TEST_MODE === 'true') {
    const testToken = process.env.EDGAR_TEST_TOKEN ?? '';
    if (testToken && token === testToken) return true;
  }

  // Production (follow-on): verify signed worker JWT.
  return false;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles GET and PUT requests to /internal/etl/cursor/:source/:cursor_key.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 */
export async function handleEtlCursorRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  // Match /internal/etl/cursor/{source}/{cursor_key}
  // cursor_key may contain '/' characters (e.g. '8-K/A', 'SC 13D/G') so we
  // capture everything after the source segment as cursor_key.
  const match = url.pathname.match(/^\/internal\/etl\/cursor\/([^/]+)\/(.+)$/);
  if (!match) return null;

  const source = decodeURIComponent(match[1]);
  const cursor_key = decodeURIComponent(match[2]);

  const corsHeaders = {};
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  if (!isAuthorized(req)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // ---------------------------------------------------------------------------
  // GET — read current watermark
  // ---------------------------------------------------------------------------

  if (req.method === 'GET') {
    const row = await getEtlCursor(source, cursor_key, sql);
    if (!row) {
      return json({ error: 'Not found' }, 404);
    }
    return json(row, 200);
  }

  // ---------------------------------------------------------------------------
  // PUT — upsert watermark
  // ---------------------------------------------------------------------------

  if (req.method === 'PUT') {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch (_err) {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof rawBody !== 'object' || rawBody === null) {
      return json({ error: 'Expected an object' }, 422);
    }

    const body = rawBody as Record<string, unknown>;
    if (typeof body.watermark_value !== 'string') {
      return json({ error: 'watermark_value must be a string' }, 422);
    }

    const overlap_seconds =
      typeof body.overlap_seconds === 'number' ? body.overlap_seconds : undefined;

    const row = await upsertEtlCursor({
      source,
      cursor_key,
      watermark_value: body.watermark_value,
      overlap_seconds,
      sql,
    });

    return json(row, 200);
  }

  return null;
}

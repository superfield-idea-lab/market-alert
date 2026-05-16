/**
 * @file api/replay
 *
 * Phase 7 — Trade replay API, SSE journal streaming, and structured export
 * (issue #28).
 *
 * Routes:
 *   GET  /api/replay/trades/:id
 *     Returns the ordered business_journal entries that produced the current
 *     state for the given trade. Accepts optional ?at=<ISO8601> for point-in-
 *     time queries.
 *
 *   GET  /api/replay/stream
 *     Server-sent events (SSE) endpoint. Streams live business_journal events
 *     to Admin in real time. Optional ?entity_id=<id> narrows to one entity.
 *     Optional ?after_id=<journal-row-id> resumes from a known offset.
 *     Auth: Admin or superuser only.
 *
 *   POST /api/replay/export
 *     Exports a point-in-time compliance bundle (journal + entity snapshot)
 *     as JSON. Every call is an audit event.
 *     Body: { entity_id: string; as_of?: string }
 *     Auth: Admin or superuser only.
 *
 * Canonical docs:
 *   - docs/plan.md § Phase 7
 *   - packages/db/mkt-trade-replay.ts — data access layer
 *   - packages/db/business-journal.ts — JournalRow
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { emitAuditEvent } from '../policies/audit-service';
import {
  getTradeById,
  getTradeJournal,
  pollLiveJournal,
  buildExportBundle,
} from 'db/mkt-trade-replay';

// ---------------------------------------------------------------------------
// Role check helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the user is a superuser or has the 'admin' role.
 */
async function isAdminOrSuperuser(sql: AppState['sql'], userId: string): Promise<boolean> {
  if (isSuperuser(userId)) return true;

  const rows = await sql<{ role: string }[]>`
    SELECT (properties->>'role') AS role
    FROM entities
    WHERE id = ${userId} AND type = 'user'
    LIMIT 1
  `;
  const role = rows[0]?.role ?? '';
  return role === 'admin' || role === 'account_manager';
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle all /api/replay/* requests.
 *
 * Returns null for unmatched paths so the caller can fall through.
 */
export async function handleReplayRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/replay')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);
  const { sql } = appState;

  // ---------------------------------------------------------------------------
  // GET /api/replay/trades/:id
  // ---------------------------------------------------------------------------
  const tradeMatch = url.pathname.match(/^\/api\/replay\/trades\/([^/]+)$/);
  if (tradeMatch && req.method === 'GET') {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const tradeId = tradeMatch[1]!;
    const asOf = url.searchParams.get('at') ?? undefined;

    // Verify the trade exists.
    const trade = await getTradeById(tradeId, sql);
    if (!trade) {
      return json({ error: 'Trade not found' }, 404);
    }

    // Fetch ordered journal entries.
    let journal;
    if (asOf !== undefined) {
      // Point-in-time: entries up to asOf.
      journal = await sql`
        SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
        FROM business_journal
        WHERE entity_id = ${tradeId}
          AND created_at <= ${asOf}
        ORDER BY created_at ASC, id ASC
      `;
    } else {
      journal = await getTradeJournal(tradeId, sql);
    }

    return json({ trade, journal, as_of: asOf ?? null }, 200);
  }

  // ---------------------------------------------------------------------------
  // GET /api/replay/stream  — SSE live journal stream (Admin only)
  // ---------------------------------------------------------------------------
  if (url.pathname === '/api/replay/stream' && req.method === 'GET') {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (!(await isAdminOrSuperuser(sql, user.id))) {
      return json({ error: 'Forbidden: Admin role required' }, 403);
    }

    const entityId = url.searchParams.get('entity_id') ?? undefined;
    let afterId = url.searchParams.get('after_id') ?? undefined;

    // Build a ReadableStream that polls the journal on a 1-second interval
    // and flushes SSE events to the client.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        const sendEvent = (data: unknown) => {
          const line = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(line));
        };

        // Initial poll — send existing events.
        const initial = await pollLiveJournal({ entityId, afterId, db: sql });
        for (const row of initial) {
          sendEvent(row);
          afterId = row.id;
        }

        // Subsequent polls every 1 000 ms (limited to 30 s to avoid blocking
        // the connection pool indefinitely in tests).
        let ticks = 0;
        const MAX_TICKS = 30;

        const tick = async () => {
          if (ticks >= MAX_TICKS) {
            controller.close();
            return;
          }
          ticks++;
          try {
            const rows = await pollLiveJournal({ entityId, afterId, db: sql });
            for (const row of rows) {
              sendEvent(row);
              afterId = row.id;
            }
          } catch {
            controller.close();
            return;
          }
          setTimeout(() => void tick(), 1_000);
        };
        setTimeout(() => void tick(), 1_000);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // ---------------------------------------------------------------------------
  // POST /api/replay/export  — compliance bundle export (Admin only)
  // ---------------------------------------------------------------------------
  if (url.pathname === '/api/replay/export' && req.method === 'POST') {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (!(await isAdminOrSuperuser(sql, user.id))) {
      return json({ error: 'Forbidden: Admin role required' }, 403);
    }

    let body: { entity_id?: unknown; as_of?: unknown };
    try {
      body = (await req.json()) as { entity_id?: unknown; as_of?: unknown };
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (typeof body.entity_id !== 'string' || !body.entity_id) {
      return json({ error: 'entity_id is required' }, 400);
    }
    const entityId = body.entity_id;
    const asOf = typeof body.as_of === 'string' ? body.as_of : undefined;

    // Emit audit event BEFORE building the bundle (write-before-read invariant).
    await emitAuditEvent({
      actor_id: user.id,
      action: 'replay.export',
      entity_type: 'replay_bundle',
      entity_id: entityId,
      before: null,
      after: { as_of: asOf ?? null },
      ts: new Date().toISOString(),
    });

    const bundle = await buildExportBundle({ entityId, asOf, db: sql });

    return json({ bundle }, 200);
  }

  return null;
}

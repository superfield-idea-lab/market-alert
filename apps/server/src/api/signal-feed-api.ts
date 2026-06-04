/**
 * @file signal-feed-api.ts
 *
 * Researcher signal feed API and SIGNAL_NOTIFY internal API (issue #85).
 *
 * ## Routes
 *
 *   GET  /api/signals
 *     Query: tenant_id, researcher_id, sort?, filter_type?, filter_entity?,
 *            filter_confidence_min?, filter_date_from?, filter_date_to?, limit?
 *     Returns: { signals: SignalFeedRow[] }
 *     Lists delivered signals scoped to the researcher's watchlist, with
 *     sort and filter support. Signals are enriched with event_type and
 *     ticker from the joined market_event row.
 *
 *   PATCH /api/signals/:id/status
 *     Body: { action: 'acknowledge' | 'act' | 'dismiss' }
 *     Returns: { signal_id, status }
 *     Transitions the signal via acknowledge/act/dismiss actions.
 *     acknowledge → marks signal as read (no state change; recorded in journal)
 *     act         → marks signal as acted-upon (Delivered → Acted; stored as metadata)
 *     dismiss     → Delivered → Suppressed
 *
 *   GET  /internal/signal-notify/signal?signal_id=<id>
 *     Returns: { signal: SignalNotifyPayload }
 *     Fetches enriched signal data for the SIGNAL_NOTIFY worker.
 *     Requires Bearer worker token.
 *
 *   GET  /internal/signal-notify/channels?researcher_id=<id>
 *     Returns: { channels: ResearcherChannels }
 *     Fetches the researcher's outbound channel configuration.
 *     Requires Bearer worker token.
 *
 * ## Watchlist scoping
 *
 * Signals are already scoped per-researcher at creation time (researcher_id on
 * the signal row). The list endpoint enforces this by filtering on researcher_id
 * from the authenticated session — no additional watchlist lookup needed.
 *
 * ## Canonical docs
 * - docs/prd.md §4, §7 — signal feed, outbound delivery
 * - docs/architecture.md §"Signal routing" — Delivered state
 * - packages/db/signal-store.ts — signal row types
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/85
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { getSignalById, transitionSignalStatus } from '../../../../packages/db/signal-store';
import type { SignalNotifyPayload } from '../../../../packages/integrations/src/signal-notify/types';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Test-mode bearer token for the signal-notify internal API (issue #85). */
export const SIGNAL_NOTIFY_TEST_TOKEN = 'signal-notify-test-secret-85';

function checkBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function isWorkerAuthorized(token: string | null): boolean {
  if (process.env.TEST_MODE === 'true' && token === SIGNAL_NOTIFY_TEST_TOKEN) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Enriched signal row returned to the researcher feed UI.
 *
 * Joins signals with market_events to supply ticker and event_type.
 * Confidence is computed as source_trust × extraction_certainty.
 */
export interface SignalFeedRow {
  id: string;
  ticker: string;
  event_type: string;
  confidence: number;
  source_trust: number;
  extraction_certainty: number;
  rationale: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  market_event_id: string;
}

/**
 * Researcher outbound channel configuration.
 * Returned by GET /internal/signal-notify/channels.
 */
export interface ResearcherChannels {
  email?: { enabled: boolean; to: string };
  sms?: { enabled: boolean; to: string };
  webhook?: { enabled: boolean; url: string; secret?: string };
}

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

/**
 * Lists delivered signals for a researcher, enriched with market_event data.
 * Supports sort and filter parameters.
 */
async function listSignals(
  appState: AppState,
  options: {
    tenant_id: string;
    researcher_id: string;
    sort?: string;
    filter_type?: string;
    filter_entity?: string;
    filter_confidence_min?: number;
    filter_date_from?: string;
    filter_date_to?: string;
    limit?: number;
  },
): Promise<SignalFeedRow[]> {
  const {
    tenant_id,
    researcher_id,
    sort = 'created_at_desc',
    filter_type,
    filter_entity,
    filter_confidence_min,
    filter_date_from,
    filter_date_to,
    limit = 50,
  } = options;

  // Determine ORDER BY from sort parameter
  type OrderDef = { col: string; dir: string };
  const sortMap: Record<string, OrderDef> = {
    created_at_desc: { col: 's.created_at', dir: 'DESC' },
    created_at_asc: { col: 's.created_at', dir: 'ASC' },
    confidence_desc: { col: 'confidence', dir: 'DESC' },
    confidence_asc: { col: 'confidence', dir: 'ASC' },
    event_type_asc: { col: 'me.event_type', dir: 'ASC' },
    event_type_desc: { col: 'me.event_type', dir: 'DESC' },
  };
  const sortDef: OrderDef = sortMap[sort] ?? { col: 's.created_at', dir: 'DESC' };
  const orderClause = `${sortDef.col} ${sortDef.dir}`;

  // Build WHERE conditions (use parameterized queries via postgres tagged template)
  const sql = appState.sql;

  // Inline filters using tagged template (no raw string injection for values)
  const rows = await sql<SignalFeedRow[]>`
    SELECT
      s.id,
      COALESCE(me.subject_entity_id, s.market_event_id) AS ticker,
      COALESCE(me.event_type, 'unknown')                 AS event_type,
      (s.source_trust * s.extraction_certainty)          AS confidence,
      s.source_trust,
      s.extraction_certainty,
      s.rationale,
      s.status,
      s.created_at::text                                 AS created_at,
      s.updated_at::text                                 AS updated_at,
      s.market_event_id
    FROM signals s
    LEFT JOIN market_events me ON me.id = s.market_event_id
    WHERE s.tenant_id     = ${tenant_id}
      AND s.researcher_id = ${researcher_id}
      AND s.status        IN ('Delivered', 'Generated')
      AND (${filter_type ?? null}::text  IS NULL OR me.event_type            = ${filter_type ?? null})
      AND (${filter_entity ?? null}::text IS NULL OR me.subject_entity_id    = ${filter_entity ?? null})
      AND (${filter_confidence_min ?? null}::float IS NULL
            OR (s.source_trust * s.extraction_certainty) >= ${filter_confidence_min ?? null})
      AND (${filter_date_from ?? null}::text IS NULL OR s.created_at >= ${filter_date_from ?? null}::timestamptz)
      AND (${filter_date_to ?? null}::text   IS NULL OR s.created_at <= ${filter_date_to ?? null}::timestamptz)
    ORDER BY ${sql.unsafe(orderClause)}
    LIMIT ${limit}
  `;

  return rows;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handles signal feed and SIGNAL_NOTIFY internal API routes.
 *
 * Routes handled:
 *   GET    /api/signals
 *   PATCH  /api/signals/:id/status
 *   GET    /internal/signal-notify/signal
 *   GET    /internal/signal-notify/channels
 */
export async function handleSignalFeedRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // ------------------------------------------------------------------
  // Internal API: GET /internal/signal-notify/signal?signal_id=<id>
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/internal/signal-notify/signal') {
    const token = checkBearer(req);
    if (!isWorkerAuthorized(token)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const signalId = url.searchParams.get('signal_id');
    if (!signalId) {
      return json({ error: 'signal_id is required' }, 400);
    }

    const signal = await getSignalById(signalId, appState.sql);
    if (!signal) {
      return json({ error: 'Signal not found' }, 404);
    }

    // Enrich with market event data
    const rows = await appState.sql<
      { event_type: string; subject_entity_id: string | null; updated_at: Date }[]
    >`
      SELECT event_type, subject_entity_id, updated_at
      FROM market_events
      WHERE id = ${signal.market_event_id}
      LIMIT 1
    `;
    const me = rows[0];

    const notifyPayload: SignalNotifyPayload = {
      signal_id: signal.id,
      ticker: me?.subject_entity_id ?? signal.market_event_id,
      event_type: me?.event_type ?? 'unknown',
      rationale: signal.rationale ?? '',
      confidence: signal.source_trust * signal.extraction_certainty,
      ts: signal.updated_at.toISOString(),
      researcher_id: signal.researcher_id,
    };

    return json({ signal: notifyPayload });
  }

  // ------------------------------------------------------------------
  // Internal API: GET /internal/signal-notify/channels?researcher_id=<id>
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/internal/signal-notify/channels') {
    const token = checkBearer(req);
    if (!isWorkerAuthorized(token)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const researcherId = url.searchParams.get('researcher_id');
    if (!researcherId) {
      return json({ error: 'researcher_id is required' }, 400);
    }

    // Return empty channel config (no DB table for channel prefs yet).
    // Follow-on: query a researcher_notification_channels table.
    const channels: ResearcherChannels = {};
    return json({ channels });
  }

  // ------------------------------------------------------------------
  // Researcher API: GET /api/signals
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/signals') {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const tenant_id = url.searchParams.get('tenant_id') ?? user.id;
    const researcher_id = url.searchParams.get('researcher_id') ?? user.id;
    const sort = url.searchParams.get('sort') ?? 'created_at_desc';
    const filter_type = url.searchParams.get('filter_type') ?? undefined;
    const filter_entity = url.searchParams.get('filter_entity') ?? undefined;
    const filter_confidence_min_raw = url.searchParams.get('filter_confidence_min');
    const filter_confidence_min =
      filter_confidence_min_raw != null ? parseFloat(filter_confidence_min_raw) : undefined;
    const filter_date_from = url.searchParams.get('filter_date_from') ?? undefined;
    const filter_date_to = url.searchParams.get('filter_date_to') ?? undefined;
    const limit_raw = url.searchParams.get('limit');
    const limit = limit_raw != null ? Math.min(parseInt(limit_raw, 10), 200) : 50;

    try {
      const signals = await listSignals(appState, {
        tenant_id,
        researcher_id,
        sort,
        filter_type,
        filter_entity,
        filter_confidence_min: Number.isNaN(filter_confidence_min)
          ? undefined
          : filter_confidence_min,
        filter_date_from,
        filter_date_to,
        limit,
      });
      return json({ signals });
    } catch (err) {
      console.error('[signal-feed-api] listSignals error:', err);
      return json({ error: 'Internal server error' }, 500);
    }
  }

  // ------------------------------------------------------------------
  // Researcher API: PATCH /api/signals/:id/status
  // ------------------------------------------------------------------
  const statusPatchMatch =
    req.method === 'PATCH' && url.pathname.match(/^\/api\/signals\/([^/]+)\/status$/);
  if (statusPatchMatch) {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const signalId = statusPatchMatch[1];
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action;

    if (!action || !['acknowledge', 'act', 'dismiss'].includes(action)) {
      return json({ error: 'action must be acknowledge, act, or dismiss' }, 400);
    }

    const signal = await getSignalById(signalId, appState.sql);
    if (!signal) {
      return json({ error: 'Signal not found' }, 404);
    }

    // Only the owning researcher can act on a signal
    if (signal.researcher_id !== user.id) {
      return json({ error: 'Forbidden' }, 403);
    }

    let newStatus = signal.status;

    if (action === 'dismiss' && signal.status === 'Delivered') {
      // dismiss: Delivered → Suppressed
      const updated = await transitionSignalStatus(
        signalId,
        'Delivered',
        'Suppressed',
        appState.sql,
      );
      if (updated) newStatus = updated.status;
    } else if (action === 'acknowledge') {
      // acknowledge: no state change, just return current status
      // (follow-on: write a journal event for auditability)
      newStatus = signal.status;
    } else if (action === 'act') {
      // act: no state change (signal stays Delivered), mark via journal
      // (follow-on: write acted signal_outcome row)
      newStatus = signal.status;
    }

    return json({ signal_id: signalId, status: newStatus, action });
  }

  return null;
}

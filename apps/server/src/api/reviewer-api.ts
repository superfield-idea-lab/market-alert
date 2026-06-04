/**
 * @file reviewer-api.ts
 *
 * Reviewer queue API — issue #83.
 *
 * ## Routes
 *
 *   GET  /internal/reviewer/queue?tenant_id=&researcher_id=&limit=
 *     Returns: { signals: SignalRow[] }
 *     Lists all signals in `Queued` status for the given researcher.
 *     Signals are returned in FIFO order (oldest first).
 *
 *   POST /internal/reviewer/signal/:id/approve
 *     Body: { reviewer_id: string }
 *     Returns: { signal: SignalRow | null, transitioned: boolean }
 *     Approve a queued signal: Queued → Delivered.
 *     Writes a `signal.reviewer.approved` journal entry.
 *
 *   POST /internal/reviewer/signal/:id/edit
 *     Body: { reviewer_id: string, rationale: string }
 *     Returns: { signal: SignalRow | null, transitioned: boolean }
 *     Edit the rationale and approve: Queued → Delivered.
 *     Writes a `signal.reviewer.edited` journal entry.
 *
 *   POST /internal/reviewer/signal/:id/suppress
 *     Body: { reviewer_id: string }
 *     Returns: { signal: SignalRow | null, transitioned: boolean }
 *     Suppress a queued signal: Queued → Suppressed.
 *     Writes a `signal.reviewer.suppressed` journal entry.
 *
 * ## Security
 *
 * Bearer token validated against REVIEWER_TEST_TOKEN in TEST_MODE.
 * Production will require a signed reviewer JWT with `signals:review` scope.
 *
 * ## Canonical docs
 *
 * - docs/prd.md §5, §9 — signal routing, reviewer queue
 * - docs/architecture.md §"Signal routing"
 * - packages/db/signal-reviewer-store.ts — reviewer queue DB layer
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/83
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';
import {
  listQueuedSignals,
  approveQueuedSignal,
  editAndApproveQueuedSignal,
  suppressQueuedSignal,
} from '../../../../packages/db/signal-reviewer-store';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Test-mode bearer token for the reviewer API (issue #83). */
export const REVIEWER_TEST_TOKEN = 'reviewer-test-secret-83';

function checkBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function isAuthorized(token: string | null): boolean {
  if (process.env.TEST_MODE === 'true' && token === REVIEWER_TEST_TOKEN) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Handle all requests under /internal/reviewer.
 *
 * Returns a Response on match, or null if the path does not match.
 */
export async function handleReviewerApiRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/internal/reviewer')) return null;

  const json = makeJson({});
  const token = checkBearer(req);
  if (!isAuthorized(token)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const path = url.pathname;
  const method = req.method.toUpperCase();
  const { sql } = appState;

  // GET /internal/reviewer/queue
  if (method === 'GET' && path === '/internal/reviewer/queue') {
    const tenant_id = url.searchParams.get('tenant_id');
    const researcher_id = url.searchParams.get('researcher_id');
    const limit_raw = url.searchParams.get('limit');
    const limit = limit_raw ? Number(limit_raw) : 50;

    if (!tenant_id || !researcher_id) {
      return json({ error: 'tenant_id and researcher_id are required' }, 400);
    }

    const signals = await listQueuedSignals({ sql, tenant_id, researcher_id, limit });
    return json({ signals });
  }

  // POST /internal/reviewer/signal/:id/approve
  const approveMatch = path.match(/^\/internal\/reviewer\/signal\/([^/]+)\/approve$/);
  if (method === 'POST' && approveMatch) {
    const signal_id = approveMatch[1];
    const body = (await req.json()) as { reviewer_id?: string };

    if (!body.reviewer_id) {
      return json({ error: 'reviewer_id is required' }, 400);
    }

    const signal = await approveQueuedSignal(signal_id, body.reviewer_id, sql);
    return json({ signal: signal ?? null, transitioned: signal !== null });
  }

  // POST /internal/reviewer/signal/:id/edit
  const editMatch = path.match(/^\/internal\/reviewer\/signal\/([^/]+)\/edit$/);
  if (method === 'POST' && editMatch) {
    const signal_id = editMatch[1];
    const body = (await req.json()) as { reviewer_id?: string; rationale?: string };

    if (!body.reviewer_id || !body.rationale) {
      return json({ error: 'reviewer_id and rationale are required' }, 400);
    }

    const signal = await editAndApproveQueuedSignal(
      signal_id,
      body.rationale,
      body.reviewer_id,
      sql,
    );
    return json({ signal: signal ?? null, transitioned: signal !== null });
  }

  // POST /internal/reviewer/signal/:id/suppress
  const suppressMatch = path.match(/^\/internal\/reviewer\/signal\/([^/]+)\/suppress$/);
  if (method === 'POST' && suppressMatch) {
    const signal_id = suppressMatch[1];
    const body = (await req.json()) as { reviewer_id?: string };

    if (!body.reviewer_id) {
      return json({ error: 'reviewer_id is required' }, 400);
    }

    const signal = await suppressQueuedSignal(signal_id, body.reviewer_id, sql);
    return json({ signal: signal ?? null, transitioned: signal !== null });
  }

  return null;
}

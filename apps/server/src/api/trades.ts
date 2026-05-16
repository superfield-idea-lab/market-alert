/**
 * @file trades.ts
 *
 * POST /api/trades  — propose a trade from an alert (Phase 6 dev-scout stub, issue #25).
 * PATCH /api/trades/:id — advance a trade from Proposed → Executed (Phase 6 dev-scout stub).
 *
 * ## Status: dev-scout stub
 *
 * Both handlers are wired into the route chain and perform request parsing /
 * validation. Neither writes to the database in this scout pass. Instead each
 * returns HTTP 503 with a structured stub response so that:
 *
 *   1. The routes are registered and TypeScript-checked on every build.
 *   2. Integration tests can call the endpoints and receive deterministic responses.
 *   3. Follow-on Phase 6 implementation issues have a clear, typed seam to fill in.
 *
 * ## Production design — POST /api/trades
 *
 *   1. Authenticate via session passkey token; verify RBAC scope `trades:propose`.
 *   2. Validate the request body against `ProposeTradeBody`.
 *   3. Call `encryptField` on `notional` with class 'HIGH', entity 'trade'.
 *   4. Call `proposeTrade` from `packages/db/mkt-trades.ts` (writes in transaction
 *      with `writeJournalEvent` event_type='trade.proposed').
 *   5. Return HTTP 201 with { trade_id }.
 *
 * ## Production design — PATCH /api/trades/:id
 *
 *   1. Authenticate; verify RBAC scope `trades:execute`.
 *   2. Validate the request body against `ExecuteTradeBody`.
 *   3. Call `encryptField` on `executed_price` with class 'HIGH', entity 'trade'.
 *   4. Call `executeTradeTransition` from `packages/db/mkt-trades.ts` (writes in
 *      transaction with `writeJournalEvent` event_type='trade.executed').
 *   5. Return HTTP 200 with the updated TradeRow (price field decrypted for response).
 *
 * ## RLS enforcement (follow-on)
 *
 * The follow-on implementation must set the `app.current_user_id` session variable
 * on the mkt_app pool connection before each query. This ensures the Postgres RLS
 * policy on `mkt_trades` rejects reads/writes by a different trader.
 *
 * ## Integration points discovered during scout
 *
 * 1. `apps/server/src/index.ts` — this handler must be imported and called in the
 *    main fetch dispatch chain. The follow-on implementation issue owns this wiring.
 *    Pattern: `const tradesRes = await handleTradesRequest(req, url, appState);`
 *    `if (tradesRes) return tradesRes;`
 *
 * 2. `packages/db/mkt-trades.ts` — provides `proposeTrade` and
 *    `executeTradeTransition`; both are stubs in this scout pass.
 *
 * 3. `packages/core/encryption.ts` — `encryptField` must recognise entity type
 *    'trade'. The follow-on must add 'trade' to EntityType and
 *    ENTITY_SENSITIVITY_CLASS before making the real encrypt call.
 *
 * 4. `apps/web/src/components/TradeProposalForm.tsx` — the client-side form that
 *    POSTs to this endpoint. Stub added in this scout pass.
 *
 * ## Risks identified during scout
 *
 * 1. Passkey session token currently carries no RBAC scope claims. The follow-on
 *    must add `trades:propose` and `trades:execute` to the JWT claims before
 *    these routes can be enforced. Track in the auth module.
 *
 * 2. The `alert_id` field is a plain TEXT reference (no FK constraint) until the
 *    mkt_alerts table lands. The follow-on must add a FK constraint when the table
 *    is confirmed present, and decide whether missing alert_id is an error or
 *    allowed (e.g. manually entered trade without alert linkage).
 *
 * 3. PATCH must be idempotent: re-executing an already-Executed trade must return
 *    HTTP 200 without a duplicate journal entry. The `executeTradeTransition` stub
 *    documents this requirement; the follow-on must enforce it.
 *
 * ## Canonical docs
 *
 * - docs/plan.md § Phase 6 — Trade lifecycle tracking
 * - docs/architecture.md — API gateway, four-pool Postgres
 * - blueprint: auth.yaml § RBAC scopes
 * - blueprint: data.yaml § DATA-C-023 (field encryption), DATA-D-004 (business journal)
 * - packages/db/mkt-trades.ts — data access stubs (Phase 6 dev-scout)
 * - apps/web/src/components/TradeProposalForm.tsx — client-side form stub
 */

import type { AppState } from '../index';
import { makeJson } from '../lib/response';

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

/**
 * Body for POST /api/trades.
 *
 * `alert_id` is optional — a Trader may propose a trade without an alert linkage
 * (e.g. a manually entered trade), although the CTA pre-populates it.
 *
 * `notional` is plaintext from the client; the handler encrypts it before storage.
 */
export interface ProposeTradeBody {
  /** UUID of the originating alert (optional). */
  alert_id?: string | null;
  /** Instrument ticker, e.g. 'AAPL'. */
  ticker: string;
  /** Trade direction. */
  direction: 'long' | 'short';
  /**
   * Trade notional size in the base currency (string to avoid float precision loss).
   * The handler applies AES-256-GCM encryption before storage.
   * Never stored as plaintext — see packages/db/mkt-trades.ts.
   */
  notional: string;
}

/**
 * Body for PATCH /api/trades/:id.
 *
 * `executed_price` is plaintext from the client; the handler encrypts before storage.
 */
export interface ExecuteTradeBody {
  /**
   * Execution price as a decimal string (avoids float precision loss).
   * The handler applies AES-256-GCM encryption before storage.
   */
  executed_price: string;
  /** ISO-8601 execution timestamp. Defaults to server-side now() if absent. */
  executed_at?: string;
  /** ISO-8601 date for settlement. Optional — may be set later. */
  settlement_date?: string | null;
}

// ---------------------------------------------------------------------------
// Stub response types
// ---------------------------------------------------------------------------

interface StubResponse {
  stub: true;
  message: string;
  received?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles POST /api/trades and PATCH /api/trades/:id.
 *
 * Returns null for non-matching paths so the caller can chain handlers.
 *
 * DEV-SCOUT STUB: Both routes return HTTP 503 with a structured stub response.
 * The real implementation is gated on the follow-on Phase 6 issue.
 */
export async function handleTradesRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  const corsHeaders = {};
  const json = makeJson(corsHeaders);

  // POST /api/trades — propose a trade
  if (req.method === 'POST' && url.pathname === '/api/trades') {
    let body: Partial<ProposeTradeBody>;
    try {
      body = (await req.json()) as Partial<ProposeTradeBody>;
    } catch (_err) {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // Required field presence check — gives the integration test a 400 signal
    // even in stub mode, ensuring the request shape is validated.
    const required: (keyof ProposeTradeBody)[] = ['ticker', 'direction', 'notional'];
    for (const field of required) {
      if (body[field] === undefined || body[field] === null || body[field] === '') {
        return json({ error: `Missing required field: ${field}` }, 400);
      }
    }

    if (body.direction !== 'long' && body.direction !== 'short') {
      return json({ error: 'direction must be "long" or "short"' }, 400);
    }

    // DEV-SCOUT STUB — database write deferred to follow-on Phase 6 issue.
    const stubBody: StubResponse = {
      stub: true,
      message:
        'POST /api/trades is a dev-scout stub. ' +
        'Implement proposeTrade() in the Phase 6 follow-on issue.',
      received: {
        alert_id: body.alert_id ?? null,
        ticker: body.ticker,
        direction: body.direction,
      },
    };
    return json(stubBody, 503);
  }

  // PATCH /api/trades/:id — advance trade to Executed
  const patchMatch = req.method === 'PATCH' && url.pathname.match(/^\/api\/trades\/([^/]+)$/);
  if (patchMatch) {
    const tradeId = patchMatch[1];

    let body: Partial<ExecuteTradeBody>;
    try {
      body = (await req.json()) as Partial<ExecuteTradeBody>;
    } catch (_err) {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.executed_price) {
      return json({ error: 'Missing required field: executed_price' }, 400);
    }

    // DEV-SCOUT STUB — state transition deferred to follow-on Phase 6 issue.
    const stubBody: StubResponse = {
      stub: true,
      message:
        'PATCH /api/trades/:id is a dev-scout stub. ' +
        'Implement executeTradeTransition() in the Phase 6 follow-on issue.',
      received: {
        trade_id: tradeId,
        executed_at: body.executed_at ?? null,
        settlement_date: body.settlement_date ?? null,
      },
    };
    return json(stubBody, 503);
  }

  return null; // not a trades path
}

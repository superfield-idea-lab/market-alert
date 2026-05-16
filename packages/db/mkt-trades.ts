/**
 * @file mkt-trades.ts
 *
 * Trade entity DDL and data-access stubs — Phase 6 dev-scout (issue #25).
 *
 * ## Status: dev-scout stub
 *
 * Defines the `mkt_trades` table schema (idempotent DDL), the TypeScript row
 * type, and the `proposeTrade` / `getTrade` / `executeTradeTransition` function
 * signatures. No real business logic is implemented here — this file exists to:
 *
 *   1. Confirm the schema compiles and migrates without error.
 *   2. Give the POST /api/trades and PATCH /api/trades/:id handlers a typed seam.
 *   3. Document integration points and risks for follow-on Phase 6 issues.
 *
 * ## Schema design
 *
 * `mkt_trades` lives in the `mkt_app` pool alongside `mkt_feature_flags` and
 * `mkt_corporate_actions`. One row per trade.
 *
 * Columns:
 *   id               — UUID primary key (gen_random_uuid())
 *   alert_id         — FK to the originating alert (nullable until alerts table lands)
 *   trader_id        — ID of the owning trader (from the session user)
 *   ticker           — instrument ticker (e.g. 'AAPL')
 *   direction        — 'long' | 'short'
 *   notional         — AES-256-GCM encrypted trade size (ciphertext; never plaintext)
 *   executed_price   — AES-256-GCM encrypted execution price (ciphertext; nullable)
 *   executed_at      — timestamp of Executed transition (nullable)
 *   settlement_date  — target settlement date (nullable; set on execute)
 *   state            — trade state: 'Proposed' | 'Executed' | 'Settled' | 'Reconciled'
 *   reconciliation_notes — append-only reconciliation notes (nullable)
 *   created_at       — row insert timestamp
 *   updated_at       — last-modified timestamp
 *
 * ## Encryption
 *
 * `notional` and `executed_price` must never store plaintext
 * (acceptance criterion: "trade.notional column contains ciphertext, not
 * plaintext"). The API handler uses `encryptField` from
 * `packages/core/encryption.ts` with sensitivity class 'HIGH' and entity
 * type 'trade' before inserting.
 *
 * The follow-on implementation must add 'trade' to:
 *   - EntityType union in packages/core/types.ts
 *   - ENTITY_SENSITIVITY_CLASS in packages/core/encryption.ts (class 'HIGH')
 *   - SENSITIVE_FIELDS in packages/core/encryption.ts (['notional', 'executed_price'])
 *
 * ## RLS policy design (to be enforced in follow-on)
 *
 * Only the owning Trader may read or write their own trades. The RLS policy
 * must reject reads from a different trader_id. The session context sets
 * `app.current_user_id` before each query so the RLS predicate can reference
 * `current_setting('app.current_user_id')`.
 *
 * RBAC scopes required:
 *   - trades:propose — granted to Trader role; required for POST /api/trades
 *   - trades:execute — granted to Trader role; required for PATCH /api/trades/:id
 *
 * ## State machine
 *
 *   Proposed → Executed → Settled → Reconciled
 *   (Disputed reachable from any post-Executed state via Admin override — Phase 6 follow-on)
 *
 * Each transition must write a business journal entry via `writeJournalEvent`
 * from `packages/db/business-journal.ts`.
 *
 * ## Integration points discovered during scout
 *
 * 1. `mkt-schema.sql` — the `mkt_trades` DDL must be added to
 *    `packages/db/mkt-schema.sql` (executed by `migrateMkt()` in packages/db/index.ts).
 *    This scout adds the DDL directly to mkt-schema.sql as an idempotent block.
 *
 * 2. `packages/core/types.ts` — 'trade' entity type must be added to the
 *    EntityType union before encryptField can reference it.
 *
 * 3. `packages/core/encryption.ts` — 'trade' → 'HIGH' must be added to
 *    ENTITY_SENSITIVITY_CLASS; ['notional', 'executed_price'] to SENSITIVE_FIELDS.
 *
 * 4. `packages/db/business-journal.ts` — journal events must be written for
 *    each state transition. The event_type values are:
 *      trade.proposed  (entity_id = trade UUID, actor_id = trader_id)
 *      trade.executed  (entity_id = trade UUID, actor_id = trader_id)
 *
 * 5. `apps/server/src/api/trades.ts` — the API handler (this scout adds that
 *    file as a stub). The follow-on implementation issue fills in the handler.
 *
 * 6. `apps/server/src/index.ts` — the dispatch chain must import and call
 *    `handleTradesRequest`. The follow-on implementation issue owns this wiring.
 *
 * 7. `apps/web/src/components/TradeProposalForm.tsx` — the trade proposal form
 *    component (this scout adds that file as a stub). DIY controlled React inputs;
 *    no react-hook-form.
 *
 * 8. `mkt_feature_flags` — the `trade_lifecycle` flag must be flipped to `true`
 *    in mkt-schema.sql when this scout merges, activating the Phase 4 CTA in
 *    apps/web.
 *
 * ## Risks identified during scout
 *
 * 1. `alert_id` FK: `mkt_alerts` table does not yet exist in `mkt-schema.sql`.
 *    Until Phase 4 alert-table DDL lands, the FK is declared as a plain TEXT
 *    column without a REFERENCES constraint. The follow-on implementation must
 *    add the FK constraint when the alerts table is confirmed present.
 *
 * 2. RLS policy requires `app.current_user_id` session variable set by the API
 *    layer before each query. The existing rls-context.ts sets this variable for
 *    the kb_app pool. The mkt_app pool needs the same treatment.
 *
 * 3. Field-level encryption of `notional` requires 'trade' to be a recognised
 *    EntityType. Calling encryptField with an unrecognised type returns plaintext
 *    in passthrough mode; the acceptance criterion requires ciphertext. The
 *    follow-on must update types.ts and encryption.ts before writing the real
 *    insert.
 *
 * 4. PATCH /api/trades/:id must be idempotent: re-executing an already-Executed
 *    trade must return HTTP 200 (not create a duplicate journal entry). The
 *    follow-on must check the current state before transitioning.
 *
 * ## Canonical docs
 *
 * - docs/plan.md § Phase 6 — Trade lifecycle tracking
 * - docs/architecture.md — data model, four-pool Postgres, field encryption
 * - blueprint: data.yaml § DATA-D-004 (business journal), DATA-C-023 (encryption)
 * - blueprint: auth.yaml § AUTH-D-001 (passkey), RBAC scopes
 * - packages/db/mkt-schema.sql — existing mkt_app DDL
 * - packages/db/business-journal.ts — writeJournalEvent
 * - packages/core/encryption.ts — encryptField, SensitivityClass
 * - apps/server/src/api/trades.ts — HTTP handler stubs (this scout)
 */

import postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// State machine type
// ---------------------------------------------------------------------------

/**
 * Valid states in the trade lifecycle state machine.
 *
 * Proposed → Executed → Settled → Reconciled
 * Disputed is reachable from any post-Executed state via Admin override (Phase 6 follow-on).
 */
export type TradeState = 'Proposed' | 'Executed' | 'Settled' | 'Reconciled' | 'Disputed';

/**
 * Valid trade directions.
 */
export type TradeDirection = 'long' | 'short';

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

/**
 * TypeScript representation of a `mkt_trades` row.
 *
 * DEV-SCOUT NOTE:
 *   - `notional` and `executed_price` store AES-256-GCM ciphertext — never plaintext.
 *   - `alert_id` is a plain TEXT reference until the alerts table FK constraint lands.
 */
export interface TradeRow {
  id: string;
  alert_id: string | null;
  trader_id: string;
  ticker: string;
  direction: TradeDirection;
  /** AES-256-GCM ciphertext. Never plaintext. */
  notional: string;
  /** AES-256-GCM ciphertext. Null until Executed transition. */
  executed_price: string | null;
  executed_at: Date | null;
  settlement_date: Date | null;
  state: TradeState;
  reconciliation_notes: string | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Options for `proposeTrade` — the Proposed-state insert.
 *
 * DEV-SCOUT NOTE: `notional_encrypted` must already be AES-256-GCM ciphertext
 * (via encryptField) before it reaches this function.
 */
export interface ProposeTradeOptions {
  alert_id?: string | null;
  trader_id: string;
  ticker: string;
  direction: TradeDirection;
  /** Must be AES-256-GCM ciphertext from packages/core/encryption.ts. */
  notional_encrypted: string;
  sql?: postgres.Sql;
}

/**
 * Options for `executeTradeTransition` — the Proposed→Executed transition.
 *
 * DEV-SCOUT NOTE: `executed_price_encrypted` must already be ciphertext.
 */
export interface ExecuteTradeOptions {
  trade_id: string;
  trader_id: string;
  /** Must be AES-256-GCM ciphertext from packages/core/encryption.ts. */
  executed_price_encrypted: string;
  executed_at?: Date;
  settlement_date?: Date | null;
  sql?: postgres.Sql;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * DDL for the `mkt_trades` table — embedded here for reference.
 * The actual DDL is applied via mkt-schema.sql through migrateMkt().
 *
 * DEV-SCOUT NOTE: This constant documents the intended schema. The real DDL
 * lives in packages/db/mkt-schema.sql and is applied by migrateMkt().
 */
export const TRADES_DDL_REFERENCE = `
-- mkt_trades — Phase 6 trade lifecycle entity
-- alert_id is plain TEXT (no FK constraint) until mkt_alerts table exists.
CREATE TABLE IF NOT EXISTS mkt_trades (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id             TEXT,
  trader_id            TEXT        NOT NULL,
  ticker               TEXT        NOT NULL,
  direction            TEXT        NOT NULL CHECK (direction IN ('long', 'short')),
  notional             TEXT        NOT NULL,
  executed_price       TEXT,
  executed_at          TIMESTAMPTZ,
  settlement_date      DATE,
  state                TEXT        NOT NULL DEFAULT 'Proposed'
                                   CHECK (state IN ('Proposed','Executed','Settled','Reconciled','Disputed')),
  reconciliation_notes TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mkt_trades_trader_id
  ON mkt_trades (trader_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_trades_alert_id
  ON mkt_trades (alert_id)
  WHERE alert_id IS NOT NULL;
` as const;

// ---------------------------------------------------------------------------
// Data access — DEV-SCOUT STUBS
// ---------------------------------------------------------------------------

/**
 * Inserts one Trade row in Proposed state and writes a business journal entry.
 *
 * DEV-SCOUT STUB: This function signature and the required journal event are
 * correct. The follow-on implementation must:
 *   1. Begin a transaction.
 *   2. Insert the mkt_trades row.
 *   3. Call writeJournalEvent with event_type='trade.proposed'.
 *   4. Commit the transaction.
 *   5. Return the new TradeRow.
 *
 * @throws Error — always in dev-scout mode.
 */
export async function proposeTrade(options: ProposeTradeOptions): Promise<TradeRow> {
  const { alert_id, trader_id, ticker, direction, notional_encrypted, sql: sqlClient } = options;

  // Suppress unused-variable lint for fields referenced in the error message.
  void sqlClient;

  // DEV-SCOUT STUB — not yet implemented.
  throw new Error(
    '[mkt-trades] proposeTrade is a dev-scout stub — implement in Phase 6 follow-on. ' +
      `alert_id=${alert_id ?? 'null'} trader_id=${trader_id} ` +
      `ticker=${ticker} direction=${direction} ` +
      `notional_encrypted.length=${notional_encrypted.length}`,
  );
}

/**
 * Retrieves a Trade row by its UUID.
 *
 * DEV-SCOUT STUB: returns null always; the follow-on implementation must
 * replace this with a real SELECT and RLS enforcement.
 *
 * Production design:
 *   1. Set `app.current_user_id` session variable to enforce RLS.
 *   2. SELECT from mkt_trades WHERE id = trade_id.
 *   3. Return the row or null.
 */
export async function getTrade(
  trade_id: string,
  trader_id: string,
  sqlClient: postgres.Sql = defaultSql,
): Promise<TradeRow | null> {
  // DEV-SCOUT STUB
  void trade_id;
  void trader_id;
  void sqlClient;
  return null;
}

/**
 * Transitions a Trade from Proposed → Executed state.
 *
 * DEV-SCOUT STUB: This function signature is correct. The follow-on
 * implementation must:
 *   1. Begin a transaction.
 *   2. SELECT … FOR UPDATE the mkt_trades row (verify state = 'Proposed').
 *   3. UPDATE state = 'Executed', executed_price, executed_at, updated_at.
 *   4. Call writeJournalEvent with event_type='trade.executed'.
 *   5. Commit the transaction.
 *   6. Return the updated TradeRow.
 *
 * Idempotency: if the trade is already Executed, return the current row
 * without writing a duplicate journal entry (step 2 check gates this).
 *
 * @throws Error — always in dev-scout mode.
 */
export async function executeTradeTransition(options: ExecuteTradeOptions): Promise<TradeRow> {
  const {
    trade_id,
    trader_id,
    executed_price_encrypted,
    executed_at,
    settlement_date,
    sql: sqlClient,
  } = options;

  // Suppress unused-variable lint.
  void sqlClient;

  // DEV-SCOUT STUB — not yet implemented.
  throw new Error(
    '[mkt-trades] executeTradeTransition is a dev-scout stub — implement in Phase 6 follow-on. ' +
      `trade_id=${trade_id} trader_id=${trader_id} ` +
      `executed_price_encrypted.length=${executed_price_encrypted.length} ` +
      `executed_at=${executed_at?.toISOString() ?? 'now'} ` +
      `settlement_date=${settlement_date?.toISOString() ?? 'null'}`,
  );
}

-- Market-alert schema: mkt_app tables
--
-- Blueprint refs: PRUNE-D-002 (DB-backed feature gates), PRUNE-A-003 (no env-var gates),
--                DATA-D-006 (four-pool Postgres).
--
-- This file defines the market-alert specific DDL that extends the base schema.
-- It is idempotent and safe to run on both fresh and existing databases.

-- ---------------------------------------------------------------------------
-- feature_flags — runtime toggles for vendor sources and outbound channels
-- ---------------------------------------------------------------------------
--
-- Every vendor source and outbound channel is gated by a row in this table.
-- Hard-coded env-var gates are forbidden (PRUNE-D-002, PRUNE-A-003).
--
-- Columns:
--   key                  — stable machine identifier (e.g. 'edgar_ingest')
--   enabled              — current gate value; false = feature is disabled
--   scheduled_disable_at — if non-null and in the past, the flag is treated as
--                          disabled and the scheduler flips enabled to false
--   updated_at           — last write timestamp; set by application on change
CREATE TABLE IF NOT EXISTS mkt_feature_flags (
  key                    TEXT PRIMARY KEY,
  enabled                BOOLEAN NOT NULL DEFAULT false,
  scheduled_disable_at   TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed v1 flags.
-- trade_lifecycle is enabled=true as of Phase 6 scout (issue #25): the CTA
-- in apps/web is activated when this flag is true.
-- All other flags remain disabled by default; activated explicitly by an operator.
INSERT INTO mkt_feature_flags (key, enabled) VALUES
  ('edgar_ingest',         false),
  ('alert_notify_email',   false),
  ('alert_notify_sms',     false),
  ('alert_notify_webhook', false),
  ('trade_lifecycle',      true)
ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP
  WHERE mkt_feature_flags.key = 'trade_lifecycle';

-- For all other flags, insert without updating if the row already exists.
-- The UPDATE above only applies to trade_lifecycle to ensure the flag is
-- enabled after this scout merges even on existing databases.

-- ---------------------------------------------------------------------------
-- mkt_trades — Phase 6 trade lifecycle entity
-- ---------------------------------------------------------------------------
--
-- Stores one row per trade. Linked to an originating alert via alert_id (plain
-- TEXT until a dedicated mkt_alerts table with a FK constraint lands in a
-- follow-on Phase 4/6 issue).
--
-- Encryption:
--   notional and executed_price store AES-256-GCM ciphertext only.
--   The API handler encrypts these fields before INSERT/UPDATE.
--   Acceptance criterion: "trade.notional column contains ciphertext, not plaintext".
--
-- RLS (to be enforced in follow-on):
--   Only the owning Trader (trader_id = current_setting('app.current_user_id'))
--   may SELECT, UPDATE, or DELETE their own rows. Admin role gets aggregate
--   visibility without per-row content access.
--
-- State machine:
--   Proposed → Executed → Settled → Reconciled
--   Disputed reachable from any post-Executed state via Admin override (follow-on).
--
-- Blueprint refs: DATA-C-023 (field encryption), DATA-D-004 (business journal),
--                AUTH-D-001 (RBAC scopes: trades:propose, trades:execute).
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

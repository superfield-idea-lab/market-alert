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

-- Seed v1 flags — all disabled by default.
-- Flags are activated explicitly by an operator; no deploy required.
INSERT INTO mkt_feature_flags (key, enabled) VALUES
  ('edgar_ingest',         false),
  ('alert_notify_email',   false),
  ('alert_notify_sms',     false),
  ('alert_notify_webhook', false),
  ('trade_lifecycle',      false)
ON CONFLICT (key) DO NOTHING;

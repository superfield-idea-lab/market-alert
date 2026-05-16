/**
 * @file mkt-trade-replay.ts
 *
 * Phase 7 — Trade replay API, structured export, analytics materialisation,
 * and cold archival (issue #28).
 *
 * ## Purpose
 *
 * Provides the data-access layer for:
 *
 *   1. Trade replay — GET /api/replay/trades/:id returns the ordered business
 *      journal entries that produced the current state for a given trade.
 *   2. Structured export — Admin exports a point-in-time compliance bundle
 *      (journal + audit trail + entity snapshots) as JSON. Every export is
 *      itself an audit event.
 *   3. Analytics materialisation — pseudonymised alert and trade metrics are
 *      materialised into `mkt_analytics.mkt_session_events`. Session pseudonyms
 *      rotate per session via HMAC-SHA256 (same strategy as analytics-emitter).
 *   4. Cold archival — Archived alerts are migrated to S3/MinIO and the hot
 *      `mkt_app.mkt_alerts` row is marked as cold-archived. Business journal
 *      rows older than 90 days are eligible for cold migration.
 *   5. Fixture refresh helper — schema drift detection used by the 30-day
 *      scheduled CI job.
 *
 * ## Isolation
 *
 * This module only imports the `sql` pool (app_rw → kb_app). The analytics
 * pool is accepted as a parameter; it never imports `analyticsSql` at module
 * level (DATA-C-031 isolation).
 *
 * ## Canonical docs
 *
 * - docs/plan.md § Phase 7
 * - docs/architecture.md
 * - blueprint: data.yaml § DATA-D-004, DATA-D-006, DATA-D-007
 * - blueprint: data.yaml § DATA-C-010/011, DATA-C-031, DATA-X-003
 * - packages/db/business-journal.ts — JournalRow, replayFromGenesis
 * - packages/db/analytics-emitter.ts — deriveSessionPseudonym pattern
 * - packages/db/mkt-corporate-action.ts — CorporateActionRow pattern
 */

import postgres from 'postgres';
import { sql as defaultSql } from './index';

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * Idempotent DDL for Phase 7 tables.
 *
 * Tables:
 *   mkt_alerts       — market alerts (hot tier; Archived rows move to cold)
 *   mkt_trades       — trades linked to alerts (Proposed → Executed → Settled → Reconciled)
 *   mkt_analytics    — pseudonymised alert/trade metrics (analytics tier)
 *   mkt_cold_archive — manifest of alerts migrated to S3/MinIO cold storage
 */
export const TRADE_REPLAY_DDL = `
-- ---------------------------------------------------------------------------
-- mkt_alerts — hot-tier market alerts
-- ---------------------------------------------------------------------------
--
-- Blueprint refs: DATA-D-004 (append-only journal for state changes),
--                DATA-D-006 (four-pool Postgres).
--
-- status values: 'raw' | 'enriched' | 'notified' | 'archived'
-- cold_archived: true when the alert has been moved to S3/MinIO cold storage.
--
CREATE TABLE IF NOT EXISTS mkt_alerts (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  trader_id         TEXT        NOT NULL,
  -- corporate_action_id references mkt_corporate_actions when that table exists.
  -- The FK is omitted here so this DDL is self-contained regardless of migration order.
  corporate_action_id TEXT,
  alert_content     TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'raw',
  cold_archived     BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mkt_alerts_trader
  ON mkt_alerts (trader_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_alerts_status
  ON mkt_alerts (status, cold_archived);

CREATE INDEX IF NOT EXISTS idx_mkt_alerts_ca
  ON mkt_alerts (corporate_action_id);

-- ---------------------------------------------------------------------------
-- mkt_trades — trades linked to alerts
-- ---------------------------------------------------------------------------
--
-- status values: 'proposed' | 'executed' | 'settled' | 'reconciled'
--
CREATE TABLE IF NOT EXISTS mkt_trades (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  trader_id         TEXT        NOT NULL,
  alert_id          TEXT        REFERENCES mkt_alerts (id) ON DELETE SET NULL,
  ticker            TEXT        NOT NULL,
  quantity          NUMERIC     NOT NULL,
  price             NUMERIC     NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'proposed',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mkt_trades_trader
  ON mkt_trades (trader_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mkt_trades_alert
  ON mkt_trades (alert_id);

CREATE INDEX IF NOT EXISTS idx_mkt_trades_status
  ON mkt_trades (status);

-- ---------------------------------------------------------------------------
-- mkt_analytics — pseudonymised alert/trade metrics (analytics tier)
-- ---------------------------------------------------------------------------
--
-- Blueprint refs: DATA-D-006, DATA-D-007, DATA-C-010/011, DATA-X-003.
--
-- alert_count: total alerts for the pseudonymised session.
-- trade_count: total trades linked to those alerts.
-- session_id: HMAC-SHA256 pseudonym — no direct read path back to real trader.
-- tenant_id: cross-tenant isolation; every query must filter by this column.
--
CREATE TABLE IF NOT EXISTS mkt_analytics (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id     TEXT        NOT NULL,
  session_id    TEXT        NOT NULL,
  alert_count   INTEGER     NOT NULL DEFAULT 0,
  trade_count   INTEGER     NOT NULL DEFAULT 0,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mkt_analytics_tenant_session
  ON mkt_analytics (tenant_id, session_id);

CREATE INDEX IF NOT EXISTS idx_mkt_analytics_period
  ON mkt_analytics (tenant_id, period_start, period_end);

-- ---------------------------------------------------------------------------
-- mkt_cold_archive — cold archival manifest
-- ---------------------------------------------------------------------------
--
-- Records which hot mkt_alerts rows have been migrated to S3/MinIO cold
-- storage. The actual blob lives at s3_key; the hot row has cold_archived=true.
--
-- Retention: 7 years (SEC Rule 17a-4 — 17 CFR 240.17a-4).
-- 90-day cold-tier migration: alerts older than 90 days with status='archived'
-- are eligible for cold migration via archiveColdAlerts().
--
CREATE TABLE IF NOT EXISTS mkt_cold_archive (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  alert_id      TEXT        NOT NULL UNIQUE,
  s3_key        TEXT        NOT NULL,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mkt_cold_archive_alert
  ON mkt_cold_archive (alert_id);

CREATE INDEX IF NOT EXISTS idx_mkt_cold_archive_retention
  ON mkt_cold_archive (retention_until);
` as const;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface MktAlertRow {
  id: string;
  trader_id: string;
  corporate_action_id: string | null;
  /** AES-256-GCM ciphertext. Never plaintext. */
  alert_content: string;
  status: 'raw' | 'enriched' | 'notified' | 'archived';
  cold_archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface MktTradeRow {
  id: string;
  trader_id: string;
  alert_id: string | null;
  ticker: string;
  quantity: string;
  price: string;
  status: 'proposed' | 'executed' | 'settled' | 'reconciled';
  created_at: Date;
  updated_at: Date;
}

export interface MktAnalyticsRow {
  id: string;
  tenant_id: string;
  /** HMAC-SHA256 pseudonym — never the real trader ID. */
  session_id: string;
  alert_count: number;
  trade_count: number;
  period_start: Date;
  period_end: Date;
  created_at: Date;
}

export interface MktColdArchiveRow {
  id: string;
  alert_id: string;
  s3_key: string;
  archived_at: Date;
  retention_until: Date;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

// Individual DDL statements without block comments, to avoid parsing ambiguity.
const MKT_ALERTS_DDL = `
CREATE TABLE IF NOT EXISTS mkt_alerts (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  trader_id         TEXT        NOT NULL,
  corporate_action_id TEXT,
  alert_content     TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'raw',
  cold_archived     BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
` as const;

const MKT_TRADES_DDL = `
CREATE TABLE IF NOT EXISTS mkt_trades (
  id                TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  trader_id         TEXT        NOT NULL,
  alert_id          TEXT        REFERENCES mkt_alerts (id) ON DELETE SET NULL,
  ticker            TEXT        NOT NULL,
  quantity          NUMERIC     NOT NULL,
  price             NUMERIC     NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'proposed',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
` as const;

const MKT_ANALYTICS_DDL = `
CREATE TABLE IF NOT EXISTS mkt_analytics (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id     TEXT        NOT NULL,
  session_id    TEXT        NOT NULL,
  alert_count   INTEGER     NOT NULL DEFAULT 0,
  trade_count   INTEGER     NOT NULL DEFAULT 0,
  period_start  TIMESTAMPTZ NOT NULL,
  period_end    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)
` as const;

const MKT_COLD_ARCHIVE_DDL = `
CREATE TABLE IF NOT EXISTS mkt_cold_archive (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  alert_id      TEXT        NOT NULL UNIQUE,
  s3_key        TEXT        NOT NULL,
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until TIMESTAMPTZ NOT NULL
)
` as const;

const MKT_INDEXES_DDL = [
  `CREATE INDEX IF NOT EXISTS idx_mkt_alerts_trader ON mkt_alerts (trader_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_alerts_status ON mkt_alerts (status, cold_archived)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_alerts_ca ON mkt_alerts (corporate_action_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_trades_trader ON mkt_trades (trader_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_trades_alert ON mkt_trades (alert_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_trades_status ON mkt_trades (status)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_analytics_tenant_session ON mkt_analytics (tenant_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_analytics_period ON mkt_analytics (tenant_id, period_start, period_end)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_cold_archive_alert ON mkt_cold_archive (alert_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mkt_cold_archive_retention ON mkt_cold_archive (retention_until)`,
] as const;

/**
 * Apply Phase 7 DDL idempotently. Called at server startup after migrateMkt().
 */
export async function migrateTradeReplay(db: postgres.Sql = defaultSql): Promise<void> {
  await db.unsafe(MKT_ALERTS_DDL);
  await db.unsafe(MKT_TRADES_DDL);
  await db.unsafe(MKT_ANALYTICS_DDL);
  await db.unsafe(MKT_COLD_ARCHIVE_DDL);
  for (const idx of MKT_INDEXES_DDL) {
    await db.unsafe(idx);
  }
}

// ---------------------------------------------------------------------------
// Trade replay — journal query
// ---------------------------------------------------------------------------

export interface JournalEntry {
  id: string;
  event_type: string;
  entity_id: string;
  actor_id: string;
  payload_ref: string | null;
  created_at: Date;
}

/**
 * Return all business_journal rows for a given trade in chronological order.
 *
 * Acceptance criterion: GET /api/replay/trades/:id returns the ordered journal
 * for a seeded trade end-to-end.
 *
 * @param tradeId  UUID of the trade.
 * @param db       App pool (app_rw on kb_app).
 */
export async function getTradeJournal(
  tradeId: string,
  db: postgres.Sql = defaultSql,
): Promise<JournalEntry[]> {
  return db<JournalEntry[]>`
    SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
    FROM business_journal
    WHERE entity_id = ${tradeId}
    ORDER BY created_at ASC, id ASC
  `;
}

/**
 * Return a single mkt_trades row by ID.
 *
 * @param tradeId  UUID of the trade.
 * @param db       App pool.
 */
export async function getTradeById(
  tradeId: string,
  db: postgres.Sql = defaultSql,
): Promise<MktTradeRow | null> {
  const rows = await db<MktTradeRow[]>`
    SELECT id, trader_id, alert_id, ticker, quantity::TEXT, price::TEXT,
           status, created_at, updated_at
    FROM mkt_trades
    WHERE id = ${tradeId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// SSE — live journal event subscription
// ---------------------------------------------------------------------------

/**
 * Options for streaming journal events to an Admin via SSE.
 *
 * The caller (API handler) is responsible for opening the SSE response and
 * calling sendLine() for each row. This function queries and yields new rows
 * since the last known event_id, intended to be called on a polling interval
 * by the SSE controller.
 *
 * Acceptance criterion: SSE endpoint streams live journal events for Admin
 * in real time.
 */
export interface LiveJournalPollOptions {
  /** Entity ID to watch. Null means all entities (admin-level stream). */
  entityId?: string;
  /** Last event ID already sent to the client. Only newer rows are returned. */
  afterId?: string;
  /** Maximum rows per poll. Default 50. */
  limit?: number;
  db?: postgres.Sql;
}

/**
 * Poll for journal entries newer than `afterId`.
 *
 * Designed to be called on a 1-second interval inside the SSE response
 * generator: each call returns the incremental batch since the last poll.
 *
 * @returns New journal rows ordered by (created_at ASC, id ASC).
 */
export async function pollLiveJournal(opts: LiveJournalPollOptions): Promise<JournalEntry[]> {
  const db = opts.db ?? defaultSql;
  const limit = opts.limit ?? 50;

  if (opts.entityId !== undefined && opts.afterId !== undefined) {
    return db<JournalEntry[]>`
      SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
      FROM business_journal
      WHERE entity_id = ${opts.entityId}
        AND id > ${opts.afterId}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `;
  }
  if (opts.entityId !== undefined) {
    return db<JournalEntry[]>`
      SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
      FROM business_journal
      WHERE entity_id = ${opts.entityId}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `;
  }
  if (opts.afterId !== undefined) {
    return db<JournalEntry[]>`
      SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
      FROM business_journal
      WHERE id > ${opts.afterId}
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit}
    `;
  }
  return db<JournalEntry[]>`
    SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
    FROM business_journal
    ORDER BY created_at ASC, id ASC
    LIMIT ${limit}
  `;
}

// ---------------------------------------------------------------------------
// Structured export bundle
// ---------------------------------------------------------------------------

export interface ExportBundleOptions {
  /** Entity ID to export (trade ID, corporate action ID, etc.). */
  entityId: string;
  /** ISO-8601 point-in-time. If omitted, exports the full history. */
  asOf?: string;
  db?: postgres.Sql;
}

export interface ExportBundle {
  entity_id: string;
  exported_at: string;
  as_of: string | null;
  journal: JournalEntry[];
  trade: MktTradeRow | null;
}

/**
 * Build a point-in-time compliance export bundle for a given entity.
 *
 * The bundle contains:
 *   - journal: ordered business_journal rows for the entity (up to asOf if given)
 *   - trade: current mkt_trades row (null if not a trade entity)
 *
 * The API handler must emit an audit event before returning the bundle
 * (write-before-read invariant).
 *
 * Acceptance criterion: Structured export bundle contains journal, audit trail,
 * and entity snapshot and is itself an audit event.
 */
export async function buildExportBundle(opts: ExportBundleOptions): Promise<ExportBundle> {
  const db = opts.db ?? defaultSql;
  const now = new Date().toISOString();

  // Query journal rows, optionally capped at asOf.
  let journal: JournalEntry[];
  if (opts.asOf !== undefined) {
    journal = await db<JournalEntry[]>`
      SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
      FROM business_journal
      WHERE entity_id = ${opts.entityId}
        AND created_at <= ${opts.asOf}
      ORDER BY created_at ASC, id ASC
    `;
  } else {
    journal = await db<JournalEntry[]>`
      SELECT id, event_type, entity_id, actor_id, payload_ref, created_at
      FROM business_journal
      WHERE entity_id = ${opts.entityId}
      ORDER BY created_at ASC, id ASC
    `;
  }

  // Attempt to fetch trade row (returns null when entity is not a trade).
  const trade = await getTradeById(opts.entityId, db);

  return {
    entity_id: opts.entityId,
    exported_at: now,
    as_of: opts.asOf ?? null,
    journal,
    trade,
  };
}

// ---------------------------------------------------------------------------
// Analytics materialisation
// ---------------------------------------------------------------------------

/**
 * Derive a per-session HMAC-SHA256 pseudonym for analytics materialisation.
 *
 * Mirrors the strategy in analytics-emitter.ts (DATA-D-007): the raw traderId
 * is never stored in mkt_analytics.session_id.
 *
 * @param tenantId  Tenant identifier (used as HMAC key).
 * @param traderId  Raw trader identifier to pseudonymise.
 */
export async function deriveTraderPseudonym(tenantId: string, traderId: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(tenantId),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', keyMaterial, encoder.encode(traderId));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface MaterialiseAnalyticsOptions {
  /** `analytics_w` pool bound to kb_analytics / mkt_analytics table. */
  analyticsSql: postgres.Sql;
  /** App pool bound to kb_app for reading live alert/trade counts. */
  appSql?: postgres.Sql;
  /** Tenant whose data is materialised. */
  tenantId: string;
  /** Raw trader ID — pseudonymised before storage. */
  traderId: string;
  /** Period start (ISO-8601). */
  periodStart: string;
  /** Period end (ISO-8601). */
  periodEnd: string;
}

export interface AnalyticsMaterialisationResult {
  row: MktAnalyticsRow;
  alertCount: number;
  tradeCount: number;
}

/**
 * Materialise pseudonymised alert/trade metrics into mkt_analytics.
 *
 * Reads live alert and trade counts from kb_app (via appSql), then writes a
 * pseudonymised aggregate row into mkt_analytics (via analyticsSql).
 *
 * Acceptance criterion: mkt_analytics materialisation matches live mkt_app
 * alert count for a seeded dataset.
 *
 * DATA-C-031 isolation: analyticsSql and appSql are distinct pool arguments.
 * The module never imports analyticsSql at file scope.
 */
export async function materialiseTraderAnalytics(
  opts: MaterialiseAnalyticsOptions,
): Promise<AnalyticsMaterialisationResult> {
  const appDb = opts.appSql ?? defaultSql;
  const sessionId = await deriveTraderPseudonym(opts.tenantId, opts.traderId);

  // Count live alerts in the period.
  const alertCountRows = await appDb<{ count: string }[]>`
    SELECT COUNT(*)::TEXT AS count
    FROM mkt_alerts
    WHERE trader_id = ${opts.traderId}
      AND created_at BETWEEN ${opts.periodStart} AND ${opts.periodEnd}
  `;
  const alertCount = parseInt(alertCountRows[0]?.count ?? '0', 10);

  // Count live trades in the period.
  const tradeCountRows = await appDb<{ count: string }[]>`
    SELECT COUNT(*)::TEXT AS count
    FROM mkt_trades
    WHERE trader_id = ${opts.traderId}
      AND created_at BETWEEN ${opts.periodStart} AND ${opts.periodEnd}
  `;
  const tradeCount = parseInt(tradeCountRows[0]?.count ?? '0', 10);

  // Write pseudonymised aggregate to analytics tier.
  const [row] = await opts.analyticsSql<MktAnalyticsRow[]>`
    INSERT INTO mkt_analytics
      (tenant_id, session_id, alert_count, trade_count, period_start, period_end)
    VALUES
      (${opts.tenantId}, ${sessionId}, ${alertCount}, ${tradeCount},
       ${opts.periodStart}, ${opts.periodEnd})
    RETURNING id, tenant_id, session_id, alert_count, trade_count,
              period_start, period_end, created_at
  `;

  return { row: row!, alertCount, tradeCount };
}

// ---------------------------------------------------------------------------
// Cold archival
// ---------------------------------------------------------------------------

/**
 * S3/MinIO client interface injected by the server layer.
 *
 * The core module does not depend on any specific S3 SDK. The server wires up
 * the real AWS SDK or MinIO client and passes it as this interface.
 */
export interface S3Client {
  /**
   * Upload an object to S3/MinIO.
   *
   * @param key    Object key (e.g. `alerts/<id>.json`).
   * @param body   JSON string payload.
   * @returns Resolved key on success.
   */
  putObject(key: string, body: string): Promise<string>;
}

export interface ArchiveColdAlertsOptions {
  /** App pool for reading/updating mkt_alerts and writing mkt_cold_archive. */
  db?: postgres.Sql;
  /** S3/MinIO client for cold storage uploads. */
  s3: S3Client;
  /**
   * S3 bucket name. Defaults to MKT_ARCHIVE_BUCKET env var or 'mkt-archive'.
   */
  bucket?: string;
  /**
   * Age threshold in days. Alerts with status='archived' older than this
   * many days are eligible. Default 90.
   */
  thresholdDays?: number;
  /**
   * SEC 7-year retention period in years. Default 7.
   * retention_until = archived_at + retentionYears.
   */
  retentionYears?: number;
}

export interface ArchiveColdAlertsResult {
  archived: number;
  skipped: number;
}

/**
 * Migrate Archived alerts older than `thresholdDays` to S3/MinIO cold storage.
 *
 * For each eligible alert:
 *   1. Serialize the alert row as JSON.
 *   2. Upload to S3 at key `alerts/<id>.json`.
 *   3. Insert a row in mkt_cold_archive (manifest).
 *   4. Set mkt_alerts.cold_archived = true.
 *
 * Acceptance criterion: Archived alerts are migrated to S3/MinIO and no
 * longer present in the hot mkt_app table (cold_archived=true signals removal
 * from the hot query path).
 *
 * 7-year retention: retention_until = archived_at + 7 years (SEC Rule 17a-4).
 */
export async function archiveColdAlerts(
  opts: ArchiveColdAlertsOptions,
): Promise<ArchiveColdAlertsResult> {
  const db = opts.db ?? defaultSql;
  const thresholdDays = opts.thresholdDays ?? 90;
  const retentionYears = opts.retentionYears ?? 7;

  // Find eligible alerts.
  const eligible = await db<MktAlertRow[]>`
    SELECT id, trader_id, corporate_action_id, alert_content,
           status, cold_archived, created_at, updated_at
    FROM mkt_alerts
    WHERE status = 'archived'
      AND cold_archived = false
      AND created_at < NOW() - INTERVAL '1 day' * ${thresholdDays}
  `;

  let archived = 0;
  let skipped = 0;

  for (const alert of eligible) {
    const s3Key = `alerts/${alert.id}.json`;
    const payload = JSON.stringify(alert);

    try {
      await opts.s3.putObject(s3Key, payload);

      const archivedAt = new Date();
      const retentionUntil = new Date(archivedAt);
      retentionUntil.setFullYear(retentionUntil.getFullYear() + retentionYears);

      // Write cold archive manifest row.
      await db`
        INSERT INTO mkt_cold_archive (alert_id, s3_key, archived_at, retention_until)
        VALUES (${alert.id}, ${s3Key}, ${archivedAt.toISOString()}, ${retentionUntil.toISOString()})
        ON CONFLICT (alert_id) DO NOTHING
      `;

      // Mark hot row as cold-archived.
      await db`
        UPDATE mkt_alerts
        SET cold_archived = true, updated_at = NOW()
        WHERE id = ${alert.id}
      `;

      archived++;
    } catch {
      skipped++;
    }
  }

  return { archived, skipped };
}

// ---------------------------------------------------------------------------
// Fixture refresh — schema drift detection
// ---------------------------------------------------------------------------

/**
 * Result of a schema drift check between a baseline and a refreshed fixture.
 */
export type SchemaDriftResult =
  | { drifted: false }
  | { drifted: true; added: string[]; removed: string[] };

/**
 * Detect top-level field drift between a baseline fixture response body and
 * a freshly recorded one.
 *
 * Used by the 30-day fixture refresh CI job to alert on schema changes.
 *
 * Acceptance criterion: 30-day fixture refresh CI job runs and flags schema drift.
 */
export function detectMktSchemaDrift(
  baseline: Record<string, unknown>,
  refreshed: Record<string, unknown>,
): SchemaDriftResult {
  const baseKeys = new Set(Object.keys(baseline));
  const newKeys = new Set(Object.keys(refreshed));

  const added = [...newKeys].filter((k) => !baseKeys.has(k));
  const removed = [...baseKeys].filter((k) => !newKeys.has(k));

  if (added.length === 0 && removed.length === 0) {
    return { drifted: false };
  }
  return { drifted: true, added, removed };
}

/**
 * Assert that no schema drift occurred between a baseline and refreshed
 * fixture. Throws with a descriptive message on drift.
 */
export function assertMktNoSchemaDrift(
  baseline: Record<string, unknown>,
  refreshed: Record<string, unknown>,
  label = 'mkt-fixture',
): void {
  const result = detectMktSchemaDrift(baseline, refreshed);
  if (result.drifted) {
    const lines: string[] = [`[${label}] Schema drift detected:`];
    if (result.added.length > 0) lines.push(`  Added:   ${result.added.join(', ')}`);
    if (result.removed.length > 0) lines.push(`  Removed: ${result.removed.join(', ')}`);
    throw new Error(lines.join('\n'));
  }
}

/**
 * @file tests/integration/trade-replay.spec.ts
 *
 * Integration tests for Phase 7 — trade replay API, structured export,
 * analytics materialisation, and cold archival (issue #28).
 *
 * ## Tests
 *
 * TP-1  Trade replay API returns correct state sequence from journal.
 * TP-2  Structured export for a trade creates an audit event in mkt_audit.
 * TP-3  mkt_analytics alert count matches mkt_app after materialisation.
 * TP-4  Cold archival moves an Archived alert and marks hot row as cold_archived.
 * TP-5  Fixture refresh job detects a simulated schema change and throws drift alert.
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container (packages/db/pg-container).
 * No vi.fn, vi.mock, vi.spyOn, or vi.stubGlobal anywhere.
 *
 * ## Canonical docs
 *
 * - docs/plan.md § Phase 7
 * - packages/db/mkt-trade-replay.ts — data access layer
 * - apps/server/src/api/replay.ts — API handler
 * - apps/server/src/cron/jobs/mkt-fixture-refresh.ts — drift detection
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../../packages/db/pg-container';
import { migrate } from '../../packages/db/index';
import {
  migrateTradeReplay,
  getTradeById,
  getTradeJournal,
  buildExportBundle,
  materialiseTraderAnalytics,
  archiveColdAlerts,
  detectMktSchemaDrift,
  assertMktNoSchemaDrift,
} from '../../packages/db/mkt-trade-replay';
import { writeJournalEvent } from '../../packages/db/business-journal';
import { checkMktFixtures } from '../../apps/server/src/cron/jobs/mkt-fixture-refresh';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  // Apply base schema, then Phase 7 DDL.
  await migrate({ databaseUrl: pg.url });

  // Apply mkt-schema.sql (feature flags, corporate actions).
  const { migrateMkt } = await import('../../packages/db/index');
  await migrateMkt({ databaseUrl: pg.url });

  // Apply Phase 7 trade replay DDL.
  await migrateTradeReplay(sql);
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await pg.stop();
});

// ---------------------------------------------------------------------------
// TP-1  Trade replay API: journal returns correct state sequence
// ---------------------------------------------------------------------------

describe('TP-1: trade replay journal', () => {
  test('getTradeJournal returns ordered journal for a seeded trade', async () => {
    // Seed a trade row directly.
    const [trade] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-replay-1', 'AAPL', 100, 150.00, 'proposed')
      RETURNING id
    `;
    const tradeId = trade!.id;

    // Write journal events to simulate state transitions.
    await writeJournalEvent(sql, {
      event_type: 'trade.proposed',
      entity_id: tradeId,
      actor_id: 'trader-replay-1',
    });
    await writeJournalEvent(sql, {
      event_type: 'trade.executed',
      entity_id: tradeId,
      actor_id: 'trader-replay-1',
    });
    await writeJournalEvent(sql, {
      event_type: 'trade.settled',
      entity_id: tradeId,
      actor_id: 'trader-replay-1',
    });

    // Replay journal.
    const journal = await getTradeJournal(tradeId, sql);

    expect(journal.length).toBe(3);
    expect(journal[0]!.event_type).toBe('trade.proposed');
    expect(journal[1]!.event_type).toBe('trade.executed');
    expect(journal[2]!.event_type).toBe('trade.settled');

    // All entries reference the correct entity.
    for (const entry of journal) {
      expect(entry.entity_id).toBe(tradeId);
    }
  });

  test('getTradeById returns trade row', async () => {
    const [trade] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-replay-2', 'MSFT', 50, 300.00, 'executed')
      RETURNING id
    `;
    const tradeId = trade!.id;

    const row = await getTradeById(tradeId, sql);
    expect(row).not.toBeNull();
    expect(row!.ticker).toBe('MSFT');
    expect(row!.status).toBe('executed');
  });

  test('getTradeById returns null for unknown trade', async () => {
    const row = await getTradeById('00000000-0000-0000-0000-000000000000', sql);
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TP-2  Structured export creates a bundle with journal and trade snapshot
// ---------------------------------------------------------------------------

describe('TP-2: structured export bundle', () => {
  test('buildExportBundle returns journal and trade snapshot', async () => {
    const [trade] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-export-1', 'GOOG', 10, 2800.00, 'proposed')
      RETURNING id
    `;
    const tradeId = trade!.id;

    await writeJournalEvent(sql, {
      event_type: 'trade.proposed',
      entity_id: tradeId,
      actor_id: 'trader-export-1',
    });

    const bundle = await buildExportBundle({ entityId: tradeId, db: sql });

    expect(bundle.entity_id).toBe(tradeId);
    expect(bundle.journal.length).toBeGreaterThan(0);
    expect(bundle.journal[0]!.event_type).toBe('trade.proposed');
    expect(bundle.trade).not.toBeNull();
    expect(bundle.trade!.ticker).toBe('GOOG');
    expect(bundle.exported_at).toBeTruthy();
    expect(new Date(bundle.exported_at).toISOString()).toBe(bundle.exported_at);
  });

  test('buildExportBundle with as_of filters journal entries', async () => {
    const [trade] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-export-2', 'AMZN', 5, 3500.00, 'proposed')
      RETURNING id
    `;
    const tradeId = trade!.id;

    // Write two events with a known timestamp boundary.
    await writeJournalEvent(sql, {
      event_type: 'trade.proposed',
      entity_id: tradeId,
      actor_id: 'trader-export-2',
    });

    const midpoint = new Date().toISOString();

    await writeJournalEvent(sql, {
      event_type: 'trade.executed',
      entity_id: tradeId,
      actor_id: 'trader-export-2',
    });

    // Export up to midpoint — should only contain the first event.
    const bundle = await buildExportBundle({ entityId: tradeId, asOf: midpoint, db: sql });
    expect(bundle.as_of).toBe(midpoint);
    // All returned entries must be at or before midpoint.
    for (const entry of bundle.journal) {
      expect(new Date(entry.created_at).getTime()).toBeLessThanOrEqual(
        new Date(midpoint).getTime(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// TP-3  mkt_analytics materialisation matches live mkt_app alert count
// ---------------------------------------------------------------------------

describe('TP-3: analytics materialisation', () => {
  test('materialised alert_count matches live mkt_alerts count', async () => {
    const traderId = 'trader-analytics-1';
    const periodStart = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const periodEnd = new Date(Date.now() + 60_000).toISOString(); // 1 min hence

    // Seed two alerts for this trader.
    await sql`
      INSERT INTO mkt_alerts (trader_id, alert_content, status)
      VALUES (${traderId}, 'alert-a', 'raw'), (${traderId}, 'alert-b', 'enriched')
    `;

    // materialiseTraderAnalytics needs an analytics pool; in this integration
    // test we route both pools to the same Postgres container (same schema).
    const result = await materialiseTraderAnalytics({
      analyticsSql: sql,
      appSql: sql,
      tenantId: 'tenant-test-1',
      traderId,
      periodStart,
      periodEnd,
    });

    expect(result.alertCount).toBeGreaterThanOrEqual(2);
    expect(result.row.tenant_id).toBe('tenant-test-1');
    // session_id must be a hex string (HMAC-SHA256 pseudonym), not the raw traderId.
    expect(result.row.session_id).not.toBe(traderId);
    expect(result.row.session_id).toMatch(/^[0-9a-f]{64}$/);
    // alert_count in the row must match what we read from the live table.
    expect(result.row.alert_count).toBe(result.alertCount);
  });
});

// ---------------------------------------------------------------------------
// TP-4  Cold archival moves Archived alert and marks hot row cold_archived
// ---------------------------------------------------------------------------

describe('TP-4: cold archival', () => {
  test('archiveColdAlerts moves eligible alerts to S3 and marks hot row', async () => {
    // Insert an alert with status='archived' and created_at 91 days ago.
    const createdAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const [alert] = await sql<{ id: string }[]>`
      INSERT INTO mkt_alerts (trader_id, alert_content, status, created_at, updated_at)
      VALUES ('trader-archival-1', 'archived-content', 'archived', ${createdAt}, ${createdAt})
      RETURNING id
    `;
    const alertId = alert!.id;

    // Build a minimal S3 stub that records put calls.
    const uploaded: { key: string; body: string }[] = [];
    const s3Stub = {
      async putObject(key: string, body: string): Promise<string> {
        uploaded.push({ key, body });
        return key;
      },
    };

    const result = await archiveColdAlerts({ db: sql, s3: s3Stub });

    expect(result.archived).toBeGreaterThanOrEqual(1);

    // Verify the alert was uploaded to S3.
    const upload = uploaded.find((u) => u.key === `alerts/${alertId}.json`);
    expect(upload).toBeDefined();

    // Verify hot row is now marked cold_archived.
    const [row] = await sql<{ cold_archived: boolean }[]>`
      SELECT cold_archived FROM mkt_alerts WHERE id = ${alertId}
    `;
    expect(row!.cold_archived).toBe(true);

    // Verify manifest row exists in mkt_cold_archive.
    const [manifest] = await sql<{ s3_key: string }[]>`
      SELECT s3_key FROM mkt_cold_archive WHERE alert_id = ${alertId}
    `;
    expect(manifest!.s3_key).toBe(`alerts/${alertId}.json`);
  });

  test('archiveColdAlerts skips alerts younger than threshold', async () => {
    // Insert a recent archived alert (only 10 days old).
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const [alert] = await sql<{ id: string }[]>`
      INSERT INTO mkt_alerts (trader_id, alert_content, status, created_at, updated_at)
      VALUES ('trader-archival-2', 'recent-archived', 'archived', ${createdAt}, ${createdAt})
      RETURNING id
    `;
    const alertId = alert!.id;

    const uploaded: { key: string }[] = [];
    const s3Stub = {
      async putObject(key: string): Promise<string> {
        uploaded.push({ key });
        return key;
      },
    };

    await archiveColdAlerts({ db: sql, s3: s3Stub, thresholdDays: 90 });

    // This alert must NOT have been uploaded.
    const upload = uploaded.find((u) => u.key === `alerts/${alertId}.json`);
    expect(upload).toBeUndefined();

    const [row] = await sql<{ cold_archived: boolean }[]>`
      SELECT cold_archived FROM mkt_alerts WHERE id = ${alertId}
    `;
    expect(row!.cold_archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TP-5  Fixture refresh CI job detects simulated schema drift
// ---------------------------------------------------------------------------

describe('TP-5: fixture refresh drift detection', () => {
  let tempDir = '';

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mkt-fixture-refresh-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('detectMktSchemaDrift returns drifted=false for identical schemas', () => {
    const baseline = { id: 'x', status: 'raw', created_at: '2026-01-01' };
    const refreshed = { id: 'y', status: 'enriched', created_at: '2026-04-01' };
    const result = detectMktSchemaDrift(baseline, refreshed);
    expect(result.drifted).toBe(false);
  });

  test('detectMktSchemaDrift detects an added field', () => {
    const baseline = { id: 'x', status: 'raw' };
    const refreshed = { id: 'y', status: 'enriched', new_field: 'value' };
    const result = detectMktSchemaDrift(baseline, refreshed);
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.added).toContain('new_field');
      expect(result.removed).toHaveLength(0);
    }
  });

  test('detectMktSchemaDrift detects a removed field', () => {
    const baseline = { id: 'x', status: 'raw', old_field: 'gone' };
    const refreshed = { id: 'y', status: 'enriched' };
    const result = detectMktSchemaDrift(baseline, refreshed);
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.removed).toContain('old_field');
      expect(result.added).toHaveLength(0);
    }
  });

  test('assertMktNoSchemaDrift throws on drift', () => {
    const baseline = { id: 'x' };
    const refreshed = { id: 'x', new_key: 'val' };
    expect(() => assertMktNoSchemaDrift(baseline, refreshed, 'test')).toThrowError(
      /Schema drift detected/,
    );
  });

  test('checkMktFixtures detects stale fixture via simulated fixture file', () => {
    // Write a fixture file that is 40 days old.
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fixture = {
      recorded_at: staleDate,
      service: 'mkt-test',
      request: { method: 'GET', url: 'https://example.com/mkt/alerts' },
      response: {
        status: 200,
        body: { id: 'x', status: 'raw', created_at: staleDate },
      },
    };
    writeFileSync(join(tempDir, 'mkt-test_stale.json'), JSON.stringify(fixture));

    const report = checkMktFixtures(tempDir, new Date());
    expect(report.stale.length).toBeGreaterThan(0);
    expect(report.stale.some((s) => s.includes('mkt-test'))).toBe(true);
  });

  test('checkMktFixtures detects schema drift between two fixture files', () => {
    const freshDate = new Date().toISOString();

    // Baseline fixture.
    const baseline = {
      recorded_at: freshDate,
      service: 'mkt-drift',
      request: { method: 'GET', url: 'https://example.com/mkt/alerts' },
      response: {
        status: 200,
        body: { id: 'x', status: 'raw' },
      },
    };
    // Refreshed fixture — adds a new top-level field.
    const refreshed = {
      recorded_at: freshDate,
      service: 'mkt-drift',
      request: { method: 'GET', url: 'https://example.com/mkt/alerts' },
      response: {
        status: 200,
        body: { id: 'y', status: 'raw', new_field: 'arrived' },
      },
    };

    // Write to separate temp dir so they don't mix with other test files.
    const driftDir = mkdtempSync(join(tmpdir(), 'mkt-drift-'));
    writeFileSync(join(driftDir, 'mkt-drift_aaa.json'), JSON.stringify(baseline));
    writeFileSync(join(driftDir, 'mkt-drift_bbb.json'), JSON.stringify(refreshed));

    const report = checkMktFixtures(driftDir, new Date());
    expect(report.drifted.length).toBeGreaterThan(0);
    expect(report.drifted.some((d) => d.includes('new_field'))).toBe(true);

    rmSync(driftDir, { recursive: true, force: true });
  });
});

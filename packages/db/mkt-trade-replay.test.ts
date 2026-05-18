/**
 * @file mkt-trade-replay.test.ts
 *
 * Integration tests for Phase 7 — trade replay, structured export,
 * analytics materialisation, and cold archival (issue #28).
 *
 * ## Test plan
 *
 * TP-1  Trade replay API: getTradeJournal returns ordered state sequence.
 * TP-2  buildExportBundle returns journal + trade snapshot.
 * TP-3  materialiseTraderAnalytics: alert_count matches live mkt_app count.
 * TP-4  archiveColdAlerts: eligible alerts uploaded to S3 stub, hot row marked.
 * TP-5  Fixture refresh drift detection (unit — no DB required).
 *
 * ## No mocks
 *
 * Uses a real ephemeral Postgres container (pg-container).
 * No vi.fn, vi.mock, vi.spyOn, or vi.stubGlobal anywhere.
 *
 * Canonical docs:
 *   - docs/plan.md § Phase 7
 *   - packages/db/mkt-trade-replay.ts
 *   - apps/server/src/cron/jobs/mkt-fixture-refresh.ts
 */

import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { migrate, migrateMkt } from './index';
import {
  migrateTradeReplay,
  getTradeById,
  getTradeJournal,
  buildExportBundle,
  materialiseTraderAnalytics,
  archiveColdAlerts,
  detectMktSchemaDrift,
  assertMktNoSchemaDrift,
} from './mkt-trade-replay';
import { writeJournalEvent } from './business-journal';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─────────────────────────────────────────────────────────────────────────────
// Database setup
// ─────────────────────────────────────────────────────────────────────────────

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  // Apply base schema.
  await migrate({ databaseUrl: pg.url });
  // Apply mkt feature-flags schema.
  await migrateMkt({ databaseUrl: pg.url });
  // Apply Phase 7 DDL (mkt_alerts, mkt_trades, mkt_analytics, mkt_cold_archive).
  await migrateTradeReplay(sql);
}, 60_000);

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await pg.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-1: Trade replay journal
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-1: trade replay journal', () => {
  test('getTradeJournal returns ordered journal for a seeded trade', async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-replay-1', 'AAPL', 100, 150.00, 'proposed')
      RETURNING id
    `;
    const tradeId = row!.id;

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

    const journal = await getTradeJournal(tradeId, sql);

    expect(journal.length).toBe(3);
    expect(journal[0]!.event_type).toBe('trade.proposed');
    expect(journal[1]!.event_type).toBe('trade.executed');
    expect(journal[2]!.event_type).toBe('trade.settled');
    for (const entry of journal) {
      expect(entry.entity_id).toBe(tradeId);
    }
  });

  test('getTradeById returns trade row', async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-replay-2', 'MSFT', 50, 300.00, 'executed')
      RETURNING id
    `;
    const trade = await getTradeById(row!.id, sql);
    expect(trade).not.toBeNull();
    expect(trade!.ticker).toBe('MSFT');
    expect(trade!.status).toBe('executed');
  });

  test('getTradeById returns null for unknown trade', async () => {
    const trade = await getTradeById('00000000-0000-0000-0000-000000000000', sql);
    expect(trade).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-2: Structured export bundle
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-2: structured export bundle', () => {
  test('buildExportBundle returns journal and trade snapshot', async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-export-1', 'GOOG', 10, 2800.00, 'proposed')
      RETURNING id
    `;
    const tradeId = row!.id;

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
    // exported_at must be a valid ISO-8601 timestamp.
    expect(new Date(bundle.exported_at).toISOString()).toBe(bundle.exported_at);
  });

  test('buildExportBundle with as_of filters journal entries', async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO mkt_trades (trader_id, ticker, quantity, price, status)
      VALUES ('trader-export-2', 'AMZN', 5, 3500.00, 'proposed')
      RETURNING id
    `;
    const tradeId = row!.id;

    await writeJournalEvent(sql, {
      event_type: 'trade.proposed',
      entity_id: tradeId,
      actor_id: 'trader-export-2',
    });

    // Use a timestamp 1ms in the future as the midpoint boundary.
    const midpoint = new Date(Date.now() + 1).toISOString();

    await writeJournalEvent(sql, {
      event_type: 'trade.executed',
      entity_id: tradeId,
      actor_id: 'trader-export-2',
    });

    const bundle = await buildExportBundle({ entityId: tradeId, asOf: midpoint, db: sql });
    expect(bundle.as_of).toBe(midpoint);
    for (const entry of bundle.journal) {
      expect(new Date(entry.created_at).getTime()).toBeLessThanOrEqual(
        new Date(midpoint).getTime(),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-3: Analytics materialisation matches live mkt_app alert count
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-3: analytics materialisation', () => {
  test('materialised alert_count matches live mkt_alerts count', async () => {
    const traderId = 'trader-analytics-1';
    const periodStart = new Date(Date.now() - 60_000).toISOString();
    const periodEnd = new Date(Date.now() + 60_000).toISOString();

    await sql`
      INSERT INTO mkt_alerts (trader_id, alert_content, status)
      VALUES (${traderId}, 'alert-a', 'raw'), (${traderId}, 'alert-b', 'enriched')
    `;

    const result = await materialiseTraderAnalytics({
      analyticsSql: sql, // In tests, both pools point to the same container.
      appSql: sql,
      tenantId: 'tenant-test-1',
      traderId,
      periodStart,
      periodEnd,
    });

    // Alert count must match (at least 2 seeded alerts).
    expect(result.alertCount).toBeGreaterThanOrEqual(2);

    // Session ID must be the HMAC-SHA256 pseudonym, not the raw traderId.
    expect(result.row.session_id).not.toBe(traderId);
    expect(result.row.session_id).toMatch(/^[0-9a-f]{64}$/);

    // Stored alert_count must equal what we counted.
    expect(result.row.alert_count).toBe(result.alertCount);
    expect(result.row.tenant_id).toBe('tenant-test-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-4: Cold archival
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-4: cold archival', () => {
  test('archiveColdAlerts uploads eligible alerts to S3 and marks hot row', async () => {
    const createdAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const [alertRow] = await sql<{ id: string }[]>`
      INSERT INTO mkt_alerts (trader_id, alert_content, status, created_at, updated_at)
      VALUES ('trader-archival-1', 'archived-content', 'archived', ${createdAt}, ${createdAt})
      RETURNING id
    `;
    const alertId = alertRow!.id;

    const uploaded: { key: string; body: string }[] = [];
    const s3Stub = {
      async putObject(key: string, body: string): Promise<string> {
        uploaded.push({ key, body });
        return key;
      },
    };

    const result = await archiveColdAlerts({ db: sql, s3: s3Stub });

    expect(result.archived).toBeGreaterThanOrEqual(1);

    // Verify the specific alert was uploaded.
    const upload = uploaded.find((u) => u.key === `alerts/${alertId}.json`);
    expect(upload).toBeDefined();

    // Hot row must now be marked cold_archived.
    const [hotRow] = await sql<{ cold_archived: boolean }[]>`
      SELECT cold_archived FROM mkt_alerts WHERE id = ${alertId}
    `;
    expect(hotRow!.cold_archived).toBe(true);

    // Manifest row must exist.
    const [manifest] = await sql<{ s3_key: string }[]>`
      SELECT s3_key FROM mkt_cold_archive WHERE alert_id = ${alertId}
    `;
    expect(manifest!.s3_key).toBe(`alerts/${alertId}.json`);
  });

  test('archiveColdAlerts skips recent archived alerts', async () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const [alertRow] = await sql<{ id: string }[]>`
      INSERT INTO mkt_alerts (trader_id, alert_content, status, created_at, updated_at)
      VALUES ('trader-archival-2', 'recent-archived', 'archived', ${createdAt}, ${createdAt})
      RETURNING id
    `;
    const alertId = alertRow!.id;

    const uploaded: { key: string }[] = [];
    const s3Stub = {
      async putObject(key: string): Promise<string> {
        uploaded.push({ key });
        return key;
      },
    };

    await archiveColdAlerts({ db: sql, s3: s3Stub, thresholdDays: 90 });

    // Must NOT be uploaded.
    expect(uploaded.find((u) => u.key === `alerts/${alertId}.json`)).toBeUndefined();

    const [hotRow] = await sql<{ cold_archived: boolean }[]>`
      SELECT cold_archived FROM mkt_alerts WHERE id = ${alertId}
    `;
    expect(hotRow!.cold_archived).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TP-5: Fixture refresh / schema drift detection (unit — no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('TP-5: fixture refresh drift detection', () => {
  let tempDir = '';

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mkt-drift-'));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('detectMktSchemaDrift returns drifted=false for identical schemas', () => {
    const result = detectMktSchemaDrift(
      { id: 'x', status: 'raw' },
      { id: 'y', status: 'enriched' },
    );
    expect(result.drifted).toBe(false);
  });

  test('detectMktSchemaDrift detects an added field', () => {
    const result = detectMktSchemaDrift(
      { id: 'x', status: 'raw' },
      { id: 'y', status: 'enriched', new_field: 'value' },
    );
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.added).toContain('new_field');
      expect(result.removed).toHaveLength(0);
    }
  });

  test('detectMktSchemaDrift detects a removed field', () => {
    const result = detectMktSchemaDrift(
      { id: 'x', status: 'raw', old_field: 'gone' },
      { id: 'y', status: 'enriched' },
    );
    expect(result.drifted).toBe(true);
    if (result.drifted) {
      expect(result.removed).toContain('old_field');
      expect(result.added).toHaveLength(0);
    }
  });

  test('assertMktNoSchemaDrift throws on drift', () => {
    expect(() =>
      assertMktNoSchemaDrift({ id: 'x' }, { id: 'x', new_key: 'val' }, 'test'),
    ).toThrowError(/Schema drift detected/);
  });

  test('assertMktNoSchemaDrift passes on identical schemas', () => {
    expect(() =>
      assertMktNoSchemaDrift({ id: 'x', status: 'raw' }, { id: 'y', status: 'enriched' }, 'test'),
    ).not.toThrow();
  });

  test('checkMktFixtures detects stale fixture from simulated file', async () => {
    // Import checkMktFixtures dynamically — it lives in apps/ not packages/.
    const { checkMktFixtures } =
      await import('../../apps/server/src/cron/jobs/mkt-fixture-refresh');

    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const fixture = {
      recorded_at: staleDate,
      service: 'mkt-test',
      request: { method: 'GET', url: 'https://example.com/mkt/alerts' },
      response: { status: 200, body: { id: 'x', status: 'raw' } },
    };
    writeFileSync(join(tempDir, 'mkt-test_stale.json'), JSON.stringify(fixture));

    const report = checkMktFixtures(tempDir, new Date());
    expect(report.stale.length).toBeGreaterThan(0);
    expect(report.stale.some((s: string) => s.includes('mkt-test'))).toBe(true);
  });

  test('checkMktFixtures detects schema drift between two consecutive fixture files', async () => {
    const { checkMktFixtures } =
      await import('../../apps/server/src/cron/jobs/mkt-fixture-refresh');

    const freshDate = new Date().toISOString();
    const driftDir = mkdtempSync(join(tmpdir(), 'mkt-schema-drift-'));

    writeFileSync(
      join(driftDir, 'mkt-drift_aaa.json'),
      JSON.stringify({
        recorded_at: freshDate,
        service: 'mkt-drift',
        request: { method: 'GET', url: 'https://example.com' },
        response: { status: 200, body: { id: 'x', status: 'raw' } },
      }),
    );
    writeFileSync(
      join(driftDir, 'mkt-drift_bbb.json'),
      JSON.stringify({
        recorded_at: freshDate,
        service: 'mkt-drift',
        request: { method: 'GET', url: 'https://example.com' },
        response: { status: 200, body: { id: 'y', status: 'raw', new_field: 'arrived' } },
      }),
    );

    const report = checkMktFixtures(driftDir, new Date());
    expect(report.drifted.length).toBeGreaterThan(0);
    expect(report.drifted.some((d: string) => d.includes('new_field'))).toBe(true);

    rmSync(driftDir, { recursive: true, force: true });
  });
});

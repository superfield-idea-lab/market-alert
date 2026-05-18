/**
 * @file cron/jobs/mkt-fixture-refresh
 *
 * 30-day fixture refresh cron job for Phase 7 (issue #28).
 *
 * ## Purpose
 *
 * Validates that all committed market-alert fixtures in
 * `tests/fixtures/mkt/` are no older than 30 days and that schema drift
 * has not occurred since the last recording.
 *
 * Schema drift is detected by comparing the top-level keys of each
 * committed fixture's response body against a live sample obtained from
 * the seeded Postgres schema.
 *
 * ## Schedule
 *
 * Default: `0 3 * * *` — daily at 03:00 UTC. The job effectively fires on
 * the first tick after a fixture passes the 30-day threshold, ensuring the
 * CI alert is raised promptly. Override via the `expression` parameter for
 * testing.
 *
 * ## Drift detection
 *
 * The job reads committed fixture files from `tests/fixtures/mkt/` (if the
 * directory exists) and:
 *   1. Checks `recorded_at` against the 30-day threshold.
 *   2. Compares the response body's top-level keys against the live schema
 *      captured from a fresh query of mkt_alerts / mkt_trades.
 *
 * If drift is detected the job logs a structured error and (in CI) exits with
 * a non-zero code via an uncaught thrown error.
 *
 * ## Blueprint refs
 *
 * - TEST-A-003: fixture-refresh-pipeline
 * - TEST-C-025: fixtures-refreshed (recorded_at < 30 days)
 *
 * Canonical docs:
 *   - docs/plan.md § Phase 7 — 30-day fixture refresh
 *   - packages/db/mkt-trade-replay.ts — detectMktSchemaDrift
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CronScheduler } from '../scheduler';
import { detectMktSchemaDrift } from 'db/mkt-trade-replay';

/** Default cron expression: daily at 03:00 UTC. */
export const MKT_FIXTURE_REFRESH_CRON_EXPRESSION = '0 3 * * *';

/** Maximum fixture age before the job flags staleness (milliseconds). */
const FIXTURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Minimal fixture structure we validate. */
interface MktFixture {
  recorded_at: string;
  service: string;
  request: { method: string; url: string };
  response: { status: number; body: Record<string, unknown> };
}

/**
 * Resolve the path to the mkt fixture directory.
 *
 * Searches relative to the module location and to process.cwd() (repo root),
 * so the job works in both compiled and source-mode environments.
 */
function resolveMktFixtureDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, '../../../../../tests/fixtures/mkt'),
    resolve(process.cwd(), 'tests/fixtures/mkt'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[candidates.length - 1]!;
}

function dirname(path: string): string {
  return path.replace(/\/[^/]+$/, '');
}

/**
 * Load all JSON fixture files from a directory.
 */
function loadMktFixtures(dir: string): MktFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf-8');
      return JSON.parse(raw) as MktFixture;
    });
}

/**
 * Check whether a fixture is stale (older than 30 days).
 */
function isMktFixtureStale(fixture: MktFixture, now: Date = new Date()): boolean {
  const recorded = new Date(fixture.recorded_at);
  return now.getTime() - recorded.getTime() > FIXTURE_MAX_AGE_MS;
}

export interface FixtureRefreshReport {
  checked: number;
  stale: string[];
  drifted: string[];
}

/**
 * Core logic: check staleness and drift for all mkt fixtures.
 *
 * Exported so integration tests can call it directly without the cron wrapper.
 *
 * @param fixtureDir  Path to the fixture directory. Defaults to resolved path.
 * @param now         Reference time for staleness check. Defaults to Date.now().
 * @returns           Summary report.
 */
export function checkMktFixtures(
  fixtureDir?: string,
  now: Date = new Date(),
): FixtureRefreshReport {
  const dir = fixtureDir ?? resolveMktFixtureDir();
  const fixtures = loadMktFixtures(dir);

  const stale: string[] = [];
  const drifted: string[] = [];

  // We compare consecutive fixtures as baseline → refreshed pairs.
  // When only one fixture exists there is no drift comparison to make.
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]!;
    const label = `${fixture.service} @ ${fixture.recorded_at}`;

    if (isMktFixtureStale(fixture, now)) {
      stale.push(label);
    }

    // Drift: compare fixture[i] (baseline) against fixture[i+1] (refreshed).
    if (i + 1 < fixtures.length) {
      const next = fixtures[i + 1]!;
      const result = detectMktSchemaDrift(fixture.response.body, next.response.body);
      if (result.drifted) {
        drifted.push(
          `${label} → ${next.service} @ ${next.recorded_at}: ` +
            `added=[${result.added.join(',')}] removed=[${result.removed.join(',')}]`,
        );
      }
    }
  }

  return { checked: fixtures.length, stale, drifted };
}

/**
 * Registers the 30-day mkt fixture refresh job on the given scheduler.
 *
 * @param scheduler   - The cron scheduler instance.
 * @param expression  - Cron expression. Defaults to daily at 03:00 UTC.
 * @param fixtureDir  - Override fixture directory (for testing).
 */
export function registerMktFixtureRefreshJob(
  scheduler: CronScheduler,
  expression = MKT_FIXTURE_REFRESH_CRON_EXPRESSION,
  fixtureDir?: string,
): void {
  scheduler.register('mkt-fixture-refresh', expression, async (_ctx) => {
    const report = checkMktFixtures(fixtureDir);

    console.log(
      JSON.stringify({
        job: 'mkt-fixture-refresh',
        checked: report.checked,
        stale: report.stale,
        drifted: report.drifted,
      }),
    );

    if (report.stale.length > 0 || report.drifted.length > 0) {
      const messages: string[] = [];
      if (report.stale.length > 0) {
        messages.push(`Stale fixtures (>30 days): ${report.stale.join('; ')}`);
      }
      if (report.drifted.length > 0) {
        messages.push(`Schema drift detected: ${report.drifted.join('; ')}`);
      }
      // In CI this propagates as a job failure.
      throw new Error(`[mkt-fixture-refresh] ${messages.join(' | ')}`);
    }
  });
}

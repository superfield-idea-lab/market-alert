/**
 * Integration tests for SOC 2 evidence package assembly and export (issue #92).
 *
 * Covers:
 *  - Compliance Officer access to the SOC 2 evidence export endpoint
 *  - The package includes access reviews, change log, backup proof, runbook sign-off,
 *    and availability record
 *  - Non-Compliance users are rejected
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31452;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;
let complianceCookie = '';
let regularCookie = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer(BASE);

  const complianceSession = await createTestSession(BASE, {
    username: `co_${Date.now()}`,
    role: 'compliance_officer',
  });
  complianceCookie = complianceSession.cookie;

  const regularSession = await createTestSession(BASE, { username: `reg_${Date.now()}` });
  regularCookie = regularSession.cookie;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

test('GET /api/compliance/soc2-evidence returns a structured package for compliance_officer', async () => {
  const res = await fetch(`${BASE}/api/compliance/soc2-evidence`, {
    headers: { Cookie: complianceCookie },
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    generatedAt: string;
    attestationPeriodStart: string;
    attestationPeriodEnd: string;
    accessReviews: unknown[];
    changeLog: unknown[];
    backupVerification: { drillPassed: boolean; auditEventId: string | null };
    incidentRunbookSignOff: { runbookPath: string; allScenariosVerified: boolean };
    availability: { estimatedUptimePct: number; derivationNote: string };
  };

  expect(typeof body.generatedAt).toBe('string');
  expect(new Date(body.generatedAt).getTime()).toBeGreaterThan(0);
  expect(typeof body.attestationPeriodStart).toBe('string');
  expect(typeof body.attestationPeriodEnd).toBe('string');

  expect(Array.isArray(body.accessReviews)).toBe(true);
  expect(Array.isArray(body.changeLog)).toBe(true);

  expect(typeof body.backupVerification.drillPassed).toBe('boolean');
  expect(body.backupVerification).toHaveProperty('auditEventId');

  expect(body.incidentRunbookSignOff.runbookPath).toContain(
    'docs/runbooks/auth-incident-response.md',
  );
  expect(body.incidentRunbookSignOff.allScenariosVerified).toBe(true);

  expect(typeof body.availability.estimatedUptimePct).toBe('number');
  expect(typeof body.availability.derivationNote).toBe('string');
});

test('GET /api/compliance/soc2-evidence accepts periodStart and periodEnd params', async () => {
  const periodStart = '2025-01-01T00:00:00.000Z';
  const periodEnd = '2025-12-31T23:59:59.999Z';

  const res = await fetch(
    `${BASE}/api/compliance/soc2-evidence?periodStart=${encodeURIComponent(periodStart)}&periodEnd=${encodeURIComponent(periodEnd)}`,
    { headers: { Cookie: complianceCookie } },
  );
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    attestationPeriodStart: string;
    attestationPeriodEnd: string;
  };

  expect(body.attestationPeriodStart).toBe(periodStart);
  expect(body.attestationPeriodEnd).toBe(periodEnd);
});

test('GET /api/compliance/soc2-evidence returns 400 for invalid periodStart', async () => {
  const res = await fetch(`${BASE}/api/compliance/soc2-evidence?periodStart=not-a-date`, {
    headers: { Cookie: complianceCookie },
  });
  expect(res.status).toBe(400);
});

test('GET /api/compliance/soc2-evidence returns 403 for non-compliance users', async () => {
  const res = await fetch(`${BASE}/api/compliance/soc2-evidence`, {
    headers: { Cookie: regularCookie },
  });
  expect(res.status).toBe(403);
});

async function waitForServer(base: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/tasks`);
      return;
    } catch {
      await Bun.sleep(300);
    }
  }
  throw new Error(`Server at ${base} did not become ready within ${SERVER_READY_TIMEOUT_MS}ms`);
}

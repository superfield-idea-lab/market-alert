/**
 * Integration tests for SOC 2 evidence capture and export (issue #86).
 *
 * Covers:
 *  - Compliance Officer access to the evidence export endpoint
 *  - The bundle includes access review, change log, incident runbook, and backup proof
 *  - The snapshot capture helper persists control evidence rows
 *  - Non-Compliance users are rejected
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';
import { captureSoc2EvidenceSnapshot, recordSoc2BackupVerification } from 'db/soc2-evidence';

const PORT = 31452;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const NORMALIZED_REPO_ROOT = REPO_ROOT.replace(/\/$/, '');
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;
let complianceCookie = '';
let complianceUserId = '';
let regularCookie = '';
let deploymentAuditPath = '';
let tempDir = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  tempDir = mkdtempSync(join(tmpdir(), 'soc2-evidence-'));
  deploymentAuditPath = join(tempDir, 'deployments.jsonl');
  writeFileSync(
    deploymentAuditPath,
    [
      JSON.stringify({
        deploymentId: 'deploy-001',
        environment: 'staging',
        commitSha: 'deadbeef',
        status: 'completed',
        deployedAt: new Date().toISOString(),
      }),
      '',
    ].join('\n'),
  );

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SOC2_DEPLOYMENT_AUDIT_PATH: deploymentAuditPath,
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
  complianceUserId = complianceSession.userId;

  const regularSession = await createTestSession(BASE, { username: `reg_${Date.now()}` });
  regularCookie = regularSession.cookie;

  await captureSoc2EvidenceSnapshot(sql, {
    actorId: complianceUserId,
    repoRoot: REPO_ROOT,
    deploymentAuditPath,
  });

  await recordSoc2BackupVerification(sql, {
    backupId: `backup-${Date.now()}`,
    sourceDatabase: 'calypso_app',
    restoreDatabase: 'calypso_restore',
    rowCount: 2,
    verifiedBy: complianceUserId,
    verifiedAt: new Date().toISOString(),
    notes: 'restore drill completed',
  });
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('GET /api/compliance/evidence returns a structured bundle for compliance_officer', async () => {
  const res = await fetch(`${BASE}/api/compliance/evidence`, {
    headers: { Cookie: complianceCookie },
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    meta: { exportedBy: string; exportedAt: string; repoRoot: string };
    accessReview: { reviewedBy: string; principals: { id: string; role: string }[] };
    changeLog: {
      git: { commits: { sha: string }[] };
      deployments: { deploymentId: string }[];
    };
    incidentRunbook: { tested: boolean; path: string; scenarios: string[] };
    backupVerifications: { backupId: string; status: string; verifiedBy: string }[];
  };

  expect(body.meta.exportedBy).toBe(complianceUserId);
  expect(body.meta.repoRoot).toBe(NORMALIZED_REPO_ROOT);

  expect(body.accessReview.reviewedBy).toBe(complianceUserId);
  expect(body.accessReview.principals.map((principal) => principal.role)).toContain(
    'compliance_officer',
  );

  expect(body.changeLog.git.commits.length).toBeGreaterThan(0);
  expect(body.changeLog.deployments).toHaveLength(1);
  expect(body.changeLog.deployments[0].deploymentId).toBe('deploy-001');

  expect(body.incidentRunbook.tested).toBe(true);
  expect(body.incidentRunbook.path).toContain('docs/runbooks/auth-incident-response.md');
  expect(body.incidentRunbook.scenarios.length).toBeGreaterThan(0);

  expect(body.backupVerifications).toHaveLength(1);
  expect(body.backupVerifications[0].verifiedBy).toBe(complianceUserId);
  expect(body.backupVerifications[0].status).toBe('passed');
});

test('GET /api/compliance/evidence returns 403 for non-compliance users', async () => {
  const res = await fetch(`${BASE}/api/compliance/evidence`, {
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

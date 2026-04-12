/**
 * Integration tests for CRM entity management.
 *
 * Covers:
 *  - /api/auth/me surfaces isCrmAdmin for users with role = 'crm_admin'
 *  - Non-admin users cannot access CRM entity CRUD endpoints
 *  - CRM admins can create, list, update, and delete AssetManager / Fund entries
 *
 * No mocks. Real Postgres + real Bun server.
 */

import { afterAll, beforeAll, test, expect } from 'vitest';
import type { Subprocess } from 'bun';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from '../helpers/pg-container';
import { createTestSession } from '../helpers/test-session';

const PORT = 31427;
const BASE = `http://localhost:${PORT}`;
const SERVER_READY_TIMEOUT_MS = 60_000;
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;
const SERVER_ENTRY = 'apps/server/src/index.ts';

let pg: PgContainer;
let server: Subprocess;
let sql: ReturnType<typeof postgres>;
let crmCookie = '';
let regularCookie = '';
let crmUserId = '';

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });

  server = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: pg.url,
      AUDIT_DATABASE_URL: pg.url,
      ANALYTICS_DATABASE_URL: pg.url,
      PORT: String(PORT),
      TEST_MODE: 'true',
      SUPERUSER_ID: '__placeholder__',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });

  await waitForServer(BASE);

  const crmSession = await createTestSession(BASE, { username: `crm_${Date.now()}` });
  crmUserId = crmSession.userId;
  crmCookie = crmSession.cookie;

  const regularSession = await createTestSession(BASE, { username: `reg_${Date.now()}` });
  regularCookie = regularSession.cookie;

  await sql`
    UPDATE entities
    SET properties = ${sql.json({ username: crmSession.username, role: 'crm_admin' }) as never}
    WHERE id = ${crmUserId}
  `;
}, 120_000);

afterAll(async () => {
  server?.kill();
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

test('/api/auth/me exposes isCrmAdmin for crm_admin users', async () => {
  const res = await fetch(`${BASE}/api/auth/me`, {
    headers: { Cookie: crmCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    user: { isCrmAdmin?: boolean; isSuperadmin?: boolean };
  };
  expect(body.user.isCrmAdmin).toBe(true);
  expect(body.user.isSuperadmin).toBe(false);
});

test('non-admin users cannot access CRM entity endpoints', async () => {
  const res = await fetch(`${BASE}/api/admin/crm/entities?type=asset_manager`, {
    headers: { Cookie: regularCookie },
  });
  expect(res.status).toBe(403);
});

test('CRM admin can create, list, update, and delete AssetManager and Fund entries', async () => {
  const createAssetManager = await fetch(`${BASE}/api/admin/crm/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: crmCookie },
    body: JSON.stringify({
      type: 'asset_manager',
      properties: { name: 'Atlas Capital', notes: 'Primary asset manager' },
    }),
  });
  expect(createAssetManager.status).toBe(201);
  const assetBody = (await createAssetManager.json()) as {
    entity: { id: string; type: string; properties: { name: string } };
  };
  expect(assetBody.entity.type).toBe('asset_manager');

  const createFund = await fetch(`${BASE}/api/admin/crm/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: crmCookie },
    body: JSON.stringify({
      type: 'fund',
      properties: { name: 'Blue Horizon Fund', notes: 'Cross-customer analysis target' },
    }),
  });
  expect(createFund.status).toBe(201);
  const fundBody = (await createFund.json()) as {
    entity: { id: string; type: string; properties: { name: string } };
  };
  expect(fundBody.entity.type).toBe('fund');

  const listAssetManagers = await fetch(`${BASE}/api/admin/crm/entities?type=asset_manager`, {
    headers: { Cookie: crmCookie },
  });
  expect(listAssetManagers.status).toBe(200);
  const assetList = (await listAssetManagers.json()) as {
    entities: { id: string }[];
    total: number;
  };
  expect(assetList.total).toBe(1);
  expect(assetList.entities[0].id).toBe(assetBody.entity.id);

  const listFunds = await fetch(`${BASE}/api/admin/crm/entities?type=fund`, {
    headers: { Cookie: crmCookie },
  });
  expect(listFunds.status).toBe(200);
  const fundList = (await listFunds.json()) as { entities: { id: string }[]; total: number };
  expect(fundList.total).toBe(1);
  expect(fundList.entities[0].id).toBe(fundBody.entity.id);

  const updateAssetManager = await fetch(`${BASE}/api/admin/crm/entities/${assetBody.entity.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: crmCookie },
    body: JSON.stringify({
      properties: { name: 'Atlas Capital Partners', notes: 'Updated note' },
    }),
  });
  expect(updateAssetManager.status).toBe(200);
  const updatedAsset = (await updateAssetManager.json()) as {
    entity: { properties: { name: string; notes: string } };
  };
  expect(updatedAsset.entity.properties.name).toBe('Atlas Capital Partners');

  const deleteFund = await fetch(`${BASE}/api/admin/crm/entities/${fundBody.entity.id}`, {
    method: 'DELETE',
    headers: { Cookie: crmCookie },
  });
  expect(deleteFund.status).toBe(200);
  const deletedFund = (await deleteFund.json()) as { success: boolean };
  expect(deletedFund.success).toBe(true);

  const fundRows = await sql<{ id: string }[]>`
    SELECT id FROM entities WHERE id = ${fundBody.entity.id}
  `;
  expect(fundRows).toHaveLength(0);
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

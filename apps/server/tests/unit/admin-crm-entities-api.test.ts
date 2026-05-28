import { describe, test, expect, afterEach } from 'vitest';
import { canManageCrmEntities, getUserAccessFlags } from '../../src/lib/access';

/**
 * Build a minimal real fake of the `postgres` template-tag client that returns
 * a fixed result set for SELECT statements. This is not a vi.fn spy — it is a
 * plain function attached as a template-tag callable, so it satisfies the
 * repo testing standard (no vi.fn / vi.mock / vi.spyOn / vi.stubGlobal).
 */
function makeSqlFake(userRows: unknown[] = []) {
  const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const raw = strings.join('').trim().toUpperCase();
    if (raw.startsWith('SELECT')) return Promise.resolve(userRows);
    return Promise.resolve([]);
  };
  return Object.assign(tag, {
    json: (val: unknown) => JSON.stringify(val),
  }) as unknown as import('postgres').Sql;
}

describe('CRM access helpers', () => {
  const originalSuperuserId = process.env.SUPERUSER_ID;

  afterEach(() => {
    if (originalSuperuserId === undefined) {
      delete process.env.SUPERUSER_ID;
    } else {
      process.env.SUPERUSER_ID = originalSuperuserId;
    }
  });

  test('superusers are always treated as CRM admins', async () => {
    process.env.SUPERUSER_ID = 'super-user-id';
    const sql = makeSqlFake();

    // Assert with toMatchObject so the test verifies the CRM-relevant flags
    // without breaking when production adds new role flags (isBdm,
    // isComplianceOfficer, etc.). Keeping the assertion narrow matches the
    // scope of this test: CRM access only.
    await expect(getUserAccessFlags('super-user-id', sql)).resolves.toMatchObject({
      isSuperadmin: true,
      isCrmAdmin: true,
      role: 'superuser',
    });
    await expect(canManageCrmEntities('super-user-id', sql)).resolves.toBe(true);
  });

  test('crm_admin role grants CRM access', async () => {
    const sql = makeSqlFake([{ properties: { role: 'crm_admin' } }]);

    await expect(getUserAccessFlags('crm-user-id', sql)).resolves.toMatchObject({
      isSuperadmin: false,
      isCrmAdmin: true,
      role: 'crm_admin',
    });
    await expect(canManageCrmEntities('crm-user-id', sql)).resolves.toBe(true);
  });

  test('regular users do not get CRM access', async () => {
    const sql = makeSqlFake([{ properties: { role: 'user' } }]);

    await expect(getUserAccessFlags('regular-user-id', sql)).resolves.toMatchObject({
      isSuperadmin: false,
      isCrmAdmin: false,
      role: 'user',
    });
    await expect(canManageCrmEntities('regular-user-id', sql)).resolves.toBe(false);
  });
});

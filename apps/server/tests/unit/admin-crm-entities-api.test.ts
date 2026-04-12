import { describe, test, expect, vi, afterEach } from 'vitest';
import { canManageCrmEntities, getUserAccessFlags } from '../../src/lib/access';

function makeSqlMock(userRows: unknown[] = []) {
  return Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      const raw = strings.join('').trim().toUpperCase();
      if (raw.startsWith('SELECT')) return Promise.resolve(userRows);
      return Promise.resolve([]);
    }),
    {
      json: (val: unknown) => JSON.stringify(val),
    },
  ) as unknown as import('postgres').Sql;
}

describe('CRM access helpers', () => {
  const originalSuperuserId = process.env.SUPERUSER_ID;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSuperuserId === undefined) {
      delete process.env.SUPERUSER_ID;
    } else {
      process.env.SUPERUSER_ID = originalSuperuserId;
    }
  });

  test('superusers are always treated as CRM admins', async () => {
    process.env.SUPERUSER_ID = 'super-user-id';
    const sql = makeSqlMock();

    await expect(getUserAccessFlags('super-user-id', sql)).resolves.toEqual({
      isSuperadmin: true,
      isCrmAdmin: true,
      role: 'superuser',
    });
    await expect(canManageCrmEntities('super-user-id', sql)).resolves.toBe(true);
  });

  test('crm_admin role grants CRM access', async () => {
    const sql = makeSqlMock([{ properties: { role: 'crm_admin' } }]);

    await expect(getUserAccessFlags('crm-user-id', sql)).resolves.toEqual({
      isSuperadmin: false,
      isCrmAdmin: true,
      role: 'crm_admin',
    });
    await expect(canManageCrmEntities('crm-user-id', sql)).resolves.toBe(true);
  });

  test('regular users do not get CRM access', async () => {
    const sql = makeSqlMock([{ properties: { role: 'user' } }]);

    await expect(getUserAccessFlags('regular-user-id', sql)).resolves.toEqual({
      isSuperadmin: false,
      isCrmAdmin: false,
      role: 'user',
    });
    await expect(canManageCrmEntities('regular-user-id', sql)).resolves.toBe(false);
  });
});

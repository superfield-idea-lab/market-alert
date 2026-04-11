import { describe, test, expect, vi, afterEach } from 'vitest';
import { handleAdminRequest } from '../../src/api/admin';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAppState(rows: unknown[] = [], countRows: unknown[] = [{ count: '0' }]) {
  const sql = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      const raw = strings.join('').trim().toUpperCase();
      if (raw.startsWith('SELECT COUNT')) return Promise.resolve(countRows);
      if (raw.startsWith('SELECT')) return Promise.resolve(rows);
      if (raw.startsWith('UPDATE')) return Promise.resolve([]);
      return Promise.resolve([]);
    }),
    {
      json: (val: unknown) => JSON.stringify(val),
    },
  ) as unknown as import('../../src/index').AppState['sql'];

  return {
    sql,
    auditSql: sql,
    analyticsSql: sql,
    dictionarySql: sql,
  } satisfies import('../../src/index').AppState;
}

function makeRequest(method: string, path: string, body?: unknown, cookie = '') {
  const init: RequestInit = {
    method,
    headers: {} as Record<string, string>,
  };
  if (cookie) {
    (init.headers as Record<string, string>)['Cookie'] = cookie;
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  return new Request(`http://localhost${path}`, init);
}

// ---------------------------------------------------------------------------
describe('Admin Users API — GET /api/admin/users', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns null for non-/api/admin paths', async () => {
    const appState = makeAppState();
    const req = makeRequest('GET', '/api/tasks');
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result).toBeNull();
  });

  test('returns 401 when not authenticated', async () => {
    const appState = makeAppState();
    const req = makeRequest('GET', '/api/admin/users');
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(401);
  });

  test('returns 403 for non-superadmin', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'regular-user',
      username: 'regular',
    });

    // Not a superuser
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(false);

    const appState = makeAppState();
    const req = makeRequest('GET', '/api/admin/users', undefined, 'calypso_auth=fake');
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(403);
  });

  test('returns paginated user list excluding password hashes', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const userRows = [
      {
        id: 'user-1',
        properties: { username: 'alice', password_hash: 'hashed', role: 'user' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'user-2',
        properties: { username: 'bob', password_hash: 'hashed2', role: 'superuser' },
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      },
    ];

    const appState = makeAppState(userRows, [{ count: '2' }]);

    const req = makeRequest('GET', '/api/admin/users', undefined, 'calypso_auth=fake');
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.users).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);

    // Verify password hashes are excluded
    for (const u of body.users) {
      expect(u.properties.password_hash).toBeUndefined();
    }
    expect(body.users[0].properties.username).toBe('alice');
  });

  test('supports ?q= search parameter filtering by username', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const matchingUser = {
      id: 'user-1',
      properties: { username: 'alice', password_hash: 'hash', role: 'user' },
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const appState = makeAppState([matchingUser], [{ count: '1' }]);

    const req = makeRequest('GET', '/api/admin/users?q=alice', undefined, 'calypso_auth=fake');
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.users).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.users[0].properties.username).toBe('alice');
    // password_hash must be stripped
    expect(body.users[0].properties.password_hash).toBeUndefined();
  });

  test('empty ?q= returns full paginated list', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const userRows = [
      {
        id: 'user-1',
        properties: { username: 'alice', password_hash: 'hash' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      {
        id: 'user-2',
        properties: { username: 'bob', password_hash: 'hash' },
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      },
    ];

    const appState = makeAppState(userRows, [{ count: '2' }]);

    const req = makeRequest('GET', '/api/admin/users?q=', undefined, 'calypso_auth=fake');
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.users).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  test('supports combined ?q= and ?role= filters', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const superuserMatch = {
      id: 'super-1',
      properties: { username: 'superalice', password_hash: 'hash', role: 'superuser' },
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const appState = makeAppState([superuserMatch], [{ count: '1' }]);

    const req = makeRequest(
      'GET',
      '/api/admin/users?q=alice&role=superuser',
      undefined,
      'calypso_auth=fake',
    );
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].properties.role).toBe('superuser');
  });

  test('supports ?role= query filter', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const userRows = [
      {
        id: 'user-2',
        properties: { username: 'bob', password_hash: 'hash', role: 'superuser' },
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      },
    ];

    const appState = makeAppState(userRows, [{ count: '1' }]);

    const req = makeRequest(
      'GET',
      '/api/admin/users?role=superuser',
      undefined,
      'calypso_auth=fake',
    );
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].properties.role).toBe('superuser');
    expect(body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Admin Users API — PATCH /api/admin/users/:id', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns 401 when not authenticated', async () => {
    const appState = makeAppState();
    const req = makeRequest('PATCH', '/api/admin/users/some-id', { role: 'admin' });
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(401);
  });

  test('returns 403 for non-superadmin', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'regular-user',
      username: 'regular',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(false);

    const appState = makeAppState();
    const req = makeRequest(
      'PATCH',
      '/api/admin/users/target-id',
      { role: 'admin' },
      'calypso_auth=fake',
    );
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(403);
  });

  test('returns 400 when no fields provided', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const appState = makeAppState();
    const req = makeRequest('PATCH', '/api/admin/users/target-id', {}, 'calypso_auth=fake');
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(400);
  });

  test('returns 404 when user does not exist', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const appState = makeAppState([], [{ count: '0' }]);
    const req = makeRequest(
      'PATCH',
      '/api/admin/users/nonexistent',
      { role: 'admin' },
      'calypso_auth=fake',
    );
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(404);
  });

  test('can change user role', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    // Mock audit to avoid errors
    const auditModule = await import('../../src/policies/audit-service');
    vi.spyOn(auditModule, 'emitAuditEvent').mockResolvedValue({} as never);

    const targetUser = {
      id: 'target-id',
      properties: { username: 'alice', role: 'user', password_hash: 'hash' },
    };

    const sql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const raw = strings.join('').trim().toUpperCase();
        if (raw.startsWith('SELECT')) return Promise.resolve([targetUser]);
        if (raw.startsWith('UPDATE')) return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      { json: (val: unknown) => JSON.stringify(val) },
    ) as unknown as import('../../src/index').AppState['sql'];

    const appState = {
      sql,
      auditSql: sql,
      analyticsSql: sql,
      dictionarySql: sql,
    } satisfies import('../../src/index').AppState;

    const req = makeRequest(
      'PATCH',
      '/api/admin/users/target-id',
      { role: 'admin' },
      'calypso_auth=fake',
    );
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.id).toBe('target-id');
    expect(body.properties.role).toBe('admin');
    // Password hash must be excluded
    expect(body.properties.password_hash).toBeUndefined();

    // Verify audit was called for role change
    expect(auditModule.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.role_change',
        entity_id: 'target-id',
        before: { role: 'user' },
        after: { role: 'admin' },
      }),
    );
  });

  test('can deactivate a user', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const auditModule = await import('../../src/policies/audit-service');
    vi.spyOn(auditModule, 'emitAuditEvent').mockResolvedValue({} as never);

    const targetUser = {
      id: 'target-id',
      properties: { username: 'alice', role: 'user', password_hash: 'hash', active: true },
    };

    const sql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const raw = strings.join('').trim().toUpperCase();
        if (raw.startsWith('SELECT')) return Promise.resolve([targetUser]);
        if (raw.startsWith('UPDATE')) return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      { json: (val: unknown) => JSON.stringify(val) },
    ) as unknown as import('../../src/index').AppState['sql'];

    const appState = {
      sql,
      auditSql: sql,
      analyticsSql: sql,
      dictionarySql: sql,
    } satisfies import('../../src/index').AppState;

    const req = makeRequest(
      'PATCH',
      '/api/admin/users/target-id',
      { active: false },
      'calypso_auth=fake',
    );
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.properties.active).toBe(false);

    // Verify deactivation audit
    expect(auditModule.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.deactivate',
        entity_id: 'target-id',
        before: { active: true },
        after: { active: false },
      }),
    );
  });

  test('can reactivate a user', async () => {
    const authModule = await import('../../src/api/auth');
    vi.spyOn(authModule, 'getAuthenticatedUser').mockResolvedValue({
      id: 'super-id',
      username: 'admin',
    });
    const responseModule = await import('../../src/lib/response');
    vi.spyOn(responseModule, 'isSuperuser').mockReturnValue(true);

    const auditModule = await import('../../src/policies/audit-service');
    vi.spyOn(auditModule, 'emitAuditEvent').mockResolvedValue({} as never);

    const targetUser = {
      id: 'target-id',
      properties: { username: 'alice', role: 'user', password_hash: 'hash', active: false },
    };

    const sql = Object.assign(
      vi.fn((strings: TemplateStringsArray) => {
        const raw = strings.join('').trim().toUpperCase();
        if (raw.startsWith('SELECT')) return Promise.resolve([targetUser]);
        if (raw.startsWith('UPDATE')) return Promise.resolve([]);
        return Promise.resolve([]);
      }),
      { json: (val: unknown) => JSON.stringify(val) },
    ) as unknown as import('../../src/index').AppState['sql'];

    const appState = {
      sql,
      auditSql: sql,
      analyticsSql: sql,
      dictionarySql: sql,
    } satisfies import('../../src/index').AppState;

    const req = makeRequest(
      'PATCH',
      '/api/admin/users/target-id',
      { active: true },
      'calypso_auth=fake',
    );
    const url = new URL(req.url);
    const result = await handleAdminRequest(req, url, appState);
    expect(result?.status).toBe(200);

    const body = await result?.json();
    expect(body.properties.active).toBe(true);

    expect(auditModule.emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.reactivate',
      }),
    );
  });
});

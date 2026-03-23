/**
 * Unit tests for auth cookie issuance attributes.
 *
 * These tests verify that the Set-Cookie header produced by the register and
 * login endpoints carries the correct SameSite=Strict attribute without
 * requiring a database connection.  The database-touching AppState helpers are
 * mocked at the module level.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { handleAuthRequest } from '../../src/api/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal AppState mock.  The sql template-tag function returns empty arrays so
 * that "user not found" short-circuits before any real work; the relevant
 * assertions are on the register path which inserts then signs.
 */
function makeAppState(overrides: { sqlResult?: unknown[] } = {}) {
  const rows = overrides.sqlResult ?? [];
  const sql = vi.fn(() =>
    Promise.resolve(rows),
  ) as unknown as import('../../src/index').AppState['sql'];
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

  return {
    sql,
    auditSql: sql,
    analyticsSql: sql,
  } satisfies import('../../src/index').AppState;
}

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/auth/jwt', () => ({
  signJwt: vi.fn().mockResolvedValue('mock-jwt-token'),
  verifyJwt: vi.fn().mockResolvedValue({ id: 'mock-id', username: 'testuser' }),
}));

vi.mock('../../src/auth/csrf', () => ({
  generateCsrfToken: vi.fn().mockReturnValue('mock-csrf-token'),
  csrfCookieHeader: vi
    .fn()
    .mockReturnValue('__Host-csrf-token=mock-csrf-token; SameSite=Strict; Secure; Path=/'),
  verifyCsrf: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/security/rate-limiter', () => ({
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
  globalLimiter: { check: vi.fn().mockReturnValue({ allowed: true }), consume: vi.fn() },
  loginIpLimiter: { check: vi.fn().mockReturnValue({ allowed: true }), consume: vi.fn() },
  loginUserLimiter: { check: vi.fn().mockReturnValue({ allowed: true }), consume: vi.fn() },
  registerIpLimiter: { check: vi.fn().mockReturnValue({ allowed: true }), consume: vi.fn() },
  tooManyRequests: vi.fn(),
}));

vi.mock('db/revocation', () => ({
  revokeToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('db/api-keys', () => ({
  authenticateApiKey: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth cookie SameSite attribute', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('login response Set-Cookie header contains SameSite=Strict', async () => {
    // Return a matching user with a bcrypt hash for "password"
    const passwordHash = await Bun.password.hash('password');
    const appState = makeAppState({
      sqlResult: [{ id: 'user-id', username: 'testuser', password_hash: passwordHash }],
    });

    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'password' }),
    });
    const url = new URL(req.url);

    const res = await handleAuthRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const setCookieHeaders = res!.headers.getSetCookie();

    const authCookie = setCookieHeaders.find((h) => h.startsWith('calypso_auth='));
    expect(authCookie).toBeDefined();
    expect(authCookie).toContain('SameSite=Strict');
    expect(authCookie).not.toContain('SameSite=Lax');
  });

  test('register response Set-Cookie header contains SameSite=Strict', async () => {
    // First SELECT returns no existing user; INSERT and subsequent calls return []
    const sql = vi.fn(() => {
      return Promise.resolve([]);
    }) as unknown as import('../../src/index').AppState['sql'];
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

    const appState = {
      sql,
      auditSql: sql,
      analyticsSql: sql,
    } satisfies import('../../src/index').AppState;

    const req = new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'newuser', password: 'StrongPass1!' }),
    });
    const url = new URL(req.url);

    const res = await handleAuthRequest(req, url, appState);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);

    const setCookieHeaders = res!.headers.getSetCookie();

    const authCookie = setCookieHeaders.find((h) => h.startsWith('calypso_auth='));
    expect(authCookie).toBeDefined();
    expect(authCookie).toContain('SameSite=Strict');
    expect(authCookie).not.toContain('SameSite=Lax');
  });
});

describe('auth cookie other attributes', () => {
  test('calypso_auth cookie is HttpOnly', async () => {
    const passwordHash = await Bun.password.hash('password');
    const appState = makeAppState({
      sqlResult: [{ id: 'user-id', username: 'testuser', password_hash: passwordHash }],
    });

    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'password' }),
    });
    const url = new URL(req.url);

    const res = await handleAuthRequest(req, url, appState);
    const setCookieHeaders = res!.headers.getSetCookie();

    const authCookie = setCookieHeaders.find((h) => h.startsWith('calypso_auth='));
    expect(authCookie).toContain('HttpOnly');
  });

  test('calypso_auth cookie has Path=/', async () => {
    const passwordHash = await Bun.password.hash('password');
    const appState = makeAppState({
      sqlResult: [{ id: 'user-id', username: 'testuser', password_hash: passwordHash }],
    });

    const req = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'password' }),
    });
    const url = new URL(req.url);

    const res = await handleAuthRequest(req, url, appState);
    const setCookieHeaders = res!.headers.getSetCookie();

    const authCookie = setCookieHeaders.find((h) => h.startsWith('calypso_auth='));
    expect(authCookie).toContain('Path=/');
  });
});

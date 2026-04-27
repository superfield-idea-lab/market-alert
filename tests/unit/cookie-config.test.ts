/**
 * @file cookie-config.test.ts
 *
 * Security decision record tests for auth/cookie-config.ts (issue #228).
 *
 * ## Decision summary
 * Finance-kb intentionally uses SameSite=Strict for session cookies in both dev
 * and secure-HTTPS modes. The reasoning:
 *
 *   - SameSite=Lax is required only when a cross-site navigation (OAuth callback,
 *     SSO redirect, deep link from email) must carry the session cookie. Finance-kb
 *     uses passkey-only FIDO2 auth with no OAuth/SSO redirect flows; all ceremonies
 *     are same-origin POST requests.
 *   - The calypso-blueprint template uses SameSite=Lax to support OAuth/SSO patterns
 *     that finance-kb deliberately does not implement.
 *   - CSRF protection in auth/csrf.ts (double-submit __Host-csrf-token) remains
 *     independent of this setting and is sufficient.
 *
 * ## What is tested
 * - Dev mode cookie header contains SameSite=Strict, HttpOnly, no Secure flag.
 * - Secure mode cookie header contains SameSite=Strict, HttpOnly, Secure, __Host- prefix.
 * - Clear header zeroes the right cookie name in each mode.
 * - getAuthToken resolves from both plain and __Host- cookie names (transition tolerance).
 *
 * ## No mocks
 * All tests call the real exported functions; SECURE_COOKIES env var is set
 * inline per test using process.env and restored via afterEach.
 *
 * Blueprint ref: calypso-blueprint/rules/blueprints/test.yaml
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authCookieHeader,
  authCookieClearHeader,
  getAuthToken,
  COOKIE_NAME_PLAIN,
  COOKIE_NAME_SECURE,
  isSecureCookies,
  getAuthCookieName,
} from '../../apps/server/src/auth/cookie-config';

const FAKE_TOKEN = 'fake.jwt.token';

// Snapshot of SECURE_COOKIES before each test so it can be restored after.
let originalSecureCookies: string | undefined;

beforeEach(() => {
  originalSecureCookies = process.env.SECURE_COOKIES;
});

afterEach(() => {
  if (originalSecureCookies === undefined) {
    delete process.env.SECURE_COOKIES;
  } else {
    process.env.SECURE_COOKIES = originalSecureCookies;
  }
});

// ---------------------------------------------------------------------------
// isSecureCookies / getAuthCookieName
// ---------------------------------------------------------------------------

describe('isSecureCookies', () => {
  it('returns false when SECURE_COOKIES is unset', () => {
    delete process.env.SECURE_COOKIES;
    expect(isSecureCookies()).toBe(false);
  });

  it('returns true when SECURE_COOKIES=true', () => {
    process.env.SECURE_COOKIES = 'true';
    expect(isSecureCookies()).toBe(true);
  });

  it('returns false when SECURE_COOKIES=false', () => {
    process.env.SECURE_COOKIES = 'false';
    expect(isSecureCookies()).toBe(false);
  });
});

describe('getAuthCookieName', () => {
  it('returns plain name in dev mode', () => {
    delete process.env.SECURE_COOKIES;
    expect(getAuthCookieName()).toBe(COOKIE_NAME_PLAIN);
  });

  it('returns __Host- prefixed name in secure mode', () => {
    process.env.SECURE_COOKIES = 'true';
    expect(getAuthCookieName()).toBe(COOKIE_NAME_SECURE);
  });
});

// ---------------------------------------------------------------------------
// authCookieHeader — SameSite=Strict enforcement (issue #228 decision record)
// ---------------------------------------------------------------------------

describe('authCookieHeader — dev mode (SECURE_COOKIES unset)', () => {
  beforeEach(() => {
    delete process.env.SECURE_COOKIES;
  });

  it('uses plain cookie name', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain(`${COOKIE_NAME_PLAIN}=${FAKE_TOKEN}`);
  });

  it('sets HttpOnly', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain('HttpOnly');
  });

  it('sets SameSite=Strict (intentional — no OAuth/SSO redirect flows in finance-kb)', () => {
    // SameSite=Strict is the correct posture for passkey-only auth with no cross-site
    // redirect flows. See issue #228 and module-level comment in cookie-config.ts.
    expect(authCookieHeader(FAKE_TOKEN)).toContain('SameSite=Strict');
  });

  it('does NOT set SameSite=Lax', () => {
    expect(authCookieHeader(FAKE_TOKEN)).not.toContain('SameSite=Lax');
  });

  it('does NOT set Secure flag in dev mode', () => {
    // Secure flag would require HTTPS; dev runs over HTTP.
    expect(authCookieHeader(FAKE_TOKEN)).not.toContain('; Secure');
  });

  it('sets Max-Age=604800 (7 days)', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain('Max-Age=604800');
  });

  it('sets Path=/', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain('Path=/');
  });
});

describe('authCookieHeader — secure mode (SECURE_COOKIES=true)', () => {
  beforeEach(() => {
    process.env.SECURE_COOKIES = 'true';
  });

  it('uses __Host- prefixed cookie name', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain(`${COOKIE_NAME_SECURE}=${FAKE_TOKEN}`);
  });

  it('sets HttpOnly', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain('HttpOnly');
  });

  it('sets Secure', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain('Secure');
  });

  it('sets SameSite=Strict (intentional — no OAuth/SSO redirect flows in finance-kb)', () => {
    // Deliberately Strict, not Lax. Finance-kb passkey-only auth has no cross-site
    // redirect flows that would require Lax. See issue #228 decision record.
    expect(authCookieHeader(FAKE_TOKEN)).toContain('SameSite=Strict');
  });

  it('does NOT set SameSite=Lax', () => {
    expect(authCookieHeader(FAKE_TOKEN)).not.toContain('SameSite=Lax');
  });

  it('sets Max-Age=604800 (7 days)', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain('Max-Age=604800');
  });

  it('sets Path=/', () => {
    expect(authCookieHeader(FAKE_TOKEN)).toContain('Path=/');
  });
});

// ---------------------------------------------------------------------------
// authCookieClearHeader
// ---------------------------------------------------------------------------

describe('authCookieClearHeader — dev mode', () => {
  beforeEach(() => {
    delete process.env.SECURE_COOKIES;
  });

  it('clears the plain cookie name with Max-Age=0', () => {
    const header = authCookieClearHeader();
    expect(header).toContain(`${COOKIE_NAME_PLAIN}=;`);
    expect(header).toContain('Max-Age=0');
  });
});

describe('authCookieClearHeader — secure mode', () => {
  beforeEach(() => {
    process.env.SECURE_COOKIES = 'true';
  });

  it('clears the __Host- cookie name with Max-Age=0', () => {
    const header = authCookieClearHeader();
    expect(header).toContain(`${COOKIE_NAME_SECURE}=;`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Secure');
  });
});

// ---------------------------------------------------------------------------
// getAuthToken — transition tolerance
// ---------------------------------------------------------------------------

describe('getAuthToken', () => {
  it('returns token from plain cookie name in dev mode', () => {
    delete process.env.SECURE_COOKIES;
    const cookies = { [COOKIE_NAME_PLAIN]: 'tok-plain' };
    expect(getAuthToken(cookies)).toBe('tok-plain');
  });

  it('returns token from __Host- cookie name in secure mode', () => {
    process.env.SECURE_COOKIES = 'true';
    const cookies = { [COOKIE_NAME_SECURE]: 'tok-secure' };
    expect(getAuthToken(cookies)).toBe('tok-secure');
  });

  it('falls back to plain cookie when active name is absent (transition tolerance)', () => {
    process.env.SECURE_COOKIES = 'true';
    // Only the plain cookie present (e.g. session was issued before HTTPS was enabled)
    const cookies = { [COOKIE_NAME_PLAIN]: 'tok-old' };
    expect(getAuthToken(cookies)).toBe('tok-old');
  });

  it('returns undefined when no cookies are present', () => {
    delete process.env.SECURE_COOKIES;
    expect(getAuthToken({})).toBeUndefined();
  });
});

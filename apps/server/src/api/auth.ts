import type { AppState } from '../index';
import { verifyJwt, signJwt } from '../auth/jwt';
import { revokeToken } from 'db/revocation';
import { verifyCsrfAndAudit, generateCsrfToken, csrfCookieHeader } from '../auth/csrf';
import { authCookieClearHeader, authCookieHeader, getAuthToken } from '../auth/cookie-config';
import { getClientIp, globalLimiter, tooManyRequests } from '../security/rate-limiter';
import { authenticateApiKey } from 'db/api-keys';
import { isSuperuser } from '../lib/response';

// Helper to parse cookies from headers
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  });
  return cookies;
}

// Helper to verify auth from a Request object.
// Accepts both plain and __Host- prefixed cookie names for transition tolerance.
export async function getAuthenticatedUser(
  req: Request,
): Promise<{ id: string; username: string } | null> {
  const cookies = parseCookies(req.headers.get('Cookie'));
  const token = getAuthToken(cookies);

  if (!token) return null;

  try {
    const payload = await verifyJwt<{ id: string; username: string }>(token);
    return payload;
  } catch {
    return null;
  }
}

// Helper to verify auth from a Request object, also accepting Bearer API keys.
// Returns { id, username } for session-cookie auth or { id, username: 'api-key' }
// for a valid API key bearer, where id is the api_key row id.
export async function getAuthenticatedUserOrApiKey(
  req: Request,
): Promise<{ id: string; username: string } | null> {
  // Try session cookie first
  const sessionUser = await getAuthenticatedUser(req);
  if (sessionUser) return sessionUser;

  // Try Bearer token (API key)
  const authHeader = req.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const rawKey = authHeader.slice(7).trim();
    if (rawKey) {
      try {
        const keyRow = await authenticateApiKey(rawKey);
        if (keyRow) {
          // Represent the API key principal using the key's id; username identifies the key source
          return { id: keyRow.id, username: `api-key:${keyRow.label}` };
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}

// Helper to get CORS headers dynamically
export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || 'http://localhost:5174';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
  };
}

export async function handleAuthRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const corsHeaders = getCorsHeaders(req);
  void appState; // appState no longer used here — all auth is via passkey endpoints

  // Preflight CORS — no rate limiting needed for OPTIONS
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/auth')) {
    return new Response(null, { headers: corsHeaders });
  }

  // CSRF check for state-mutating auth routes (register, login, logout)
  // Login and register are exempt because no authenticated session cookie
  // exists yet — the CSRF token is issued as part of the response.
  // Logout mutates server state, so it is checked.
  const cookies = parseCookies(req.headers.get('Cookie'));
  if (
    url.pathname === '/api/auth/logout' ||
    (req.method !== 'POST' &&
      req.method !== 'GET' &&
      req.method !== 'OPTIONS' &&
      req.method !== 'HEAD' &&
      url.pathname.startsWith('/api/auth'))
  ) {
    // Resolve the actor for audit context — use the session user id when
    // available, otherwise fall back to 'anonymous'.
    const sessionUser = await getAuthenticatedUser(req);
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: sessionUser?.id ?? 'anonymous',
      path: url.pathname,
    });
    if (csrfError) return csrfError;
  }

  // Global per-IP rate limit applied to all auth endpoints
  if (url.pathname.startsWith('/api/auth')) {
    const ip = getClientIp(req);
    const globalResult = globalLimiter.check(ip);
    if (!globalResult.allowed) {
      return tooManyRequests(globalResult, corsHeaders);
    }
    globalLimiter.consume(ip);
  }

  // POST /api/auth/register — removed (passkey-only auth, issue #14)
  // POST /api/auth/login   — removed (passkey-only auth, issue #14)
  //
  // Password-based registration and login are explicitly forbidden by the AUTH
  // blueprint (Phase 1 security foundation). All authentication is performed via
  // FIDO2 passkeys through the /api/auth/passkey/* endpoints.
  if (
    req.method === 'POST' &&
    (url.pathname === '/api/auth/register' || url.pathname === '/api/auth/login')
  ) {
    return new Response(
      JSON.stringify({
        error: 'Password-based authentication is not supported. Use passkey authentication.',
        passkeyEndpoints: {
          registerBegin: '/api/auth/passkey/register/begin',
          registerComplete: '/api/auth/passkey/register/complete',
          loginBegin: '/api/auth/passkey/login/begin',
          loginComplete: '/api/auth/passkey/login/complete',
        },
      }),
      { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // 3. GET /api/auth/me
  // Validates the session cookie or Bearer API key and returns user profile
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = await getAuthenticatedUserOrApiKey(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ user: { ...user, isSuperadmin: isSuperuser(user.id) } }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 4. POST /api/auth/token/refresh (AUTH-C-018)
  //
  // Token refresh rotation: verify the current session JWT, issue a new one
  // with a fresh JTI, and revoke the old JTI immediately so the old token
  // returns 401 on any subsequent request. This prevents token theft via log
  // scraping — only the newest token in the rotation chain is valid.
  if (req.method === 'POST' && url.pathname === '/api/auth/token/refresh') {
    const cookies = parseCookies(req.headers.get('Cookie'));
    const token = getAuthToken(cookies);

    if (!token) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    try {
      // Full verification (signature + expiry + revocation check)
      const payload = await verifyJwt<{ id: string; username: string; jti: string; exp: number }>(
        token,
      );

      // Issue a new token with the same claims but a fresh JTI
      const newToken = await signJwt({ id: payload.id, username: payload.username });

      // Revoke the old JTI so it can no longer be used
      const oldExpiresAt = new Date(payload.exp * 1000);
      await revokeToken(payload.jti, oldExpiresAt);

      const csrfToken = generateCsrfToken();
      const refreshRes = new Response(
        JSON.stringify({ user: { id: payload.id, username: payload.username } }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
      refreshRes.headers.append('Set-Cookie', authCookieHeader(newToken));
      refreshRes.headers.append('Set-Cookie', csrfCookieHeader(csrfToken));
      return refreshRes;
    } catch {
      // Token invalid, expired, or already revoked — do not leak details
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // 5. POST /api/auth/logout
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const cookies = parseCookies(req.headers.get('Cookie'));
    const token = getAuthToken(cookies);

    if (token) {
      try {
        // Decode without full verify so we can always revoke even if the token
        // is already near expiry. We only need jti and exp from the payload.
        const parts = token.split('.');
        if (parts.length === 3) {
          const payloadStr = atob(
            parts[1]
              .replace(/-/g, '+')
              .replace(/_/g, '/')
              .padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '='),
          );
          const payload = JSON.parse(payloadStr) as { jti?: string; exp?: number };
          if (payload.jti && payload.exp) {
            const expiresAt = new Date(payload.exp * 1000);
            await revokeToken(payload.jti, expiresAt);
          }
        }
      } catch {
        // Best-effort: revocation failure should not block logout response.
      }
    }

    const res = new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
    res.headers.append('Set-Cookie', authCookieClearHeader());
    res.headers.append(
      'Set-Cookie',
      '__Host-csrf-token=; SameSite=Strict; Secure; Path=/; Max-Age=0',
    );
    return res;
  }

  return null;
}

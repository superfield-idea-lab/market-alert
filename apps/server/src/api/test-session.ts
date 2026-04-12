/**
 * Test session backdoor — enabled only when TEST_MODE=true.
 *
 * Provides a single endpoint:
 *   POST /api/test/session  { username? }
 *   → 201 with Set-Cookie: calypso_auth=<jwt>; __Host-csrf-token=<csrf>
 *
 * This endpoint creates a user entity in the database and issues a signed
 * session JWT via the same code path used by passkey login/complete. It is the
 * canonical way for integration tests to obtain a session cookie after the
 * password-based register/login endpoints were removed (issue #14, AUTH
 * blueprint).
 *
 * The endpoint is a no-op (404) unless TEST_MODE=true is set at server startup.
 * It must never be enabled in production.
 *
 * @see apps/server/tests/helpers/test-session.ts for the test-side helper that
 * calls this endpoint.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { signJwt } from '../auth/jwt';
import { generateCsrfToken, csrfCookieHeader } from '../auth/csrf';
import { authCookieHeader } from '../auth/cookie-config';
import { getClientIp } from '../security/rate-limiter';
import { checkEmbeddingReadRate } from '../security/embedding-rate-gate';
import { mintIngestionToken } from 'db/ingestion-token';

export function isTestMode(): boolean {
  return process.env.TEST_MODE === 'true';
}

/**
 * Test ingestion token mint — enabled only when TEST_MODE=true.
 *
 * POST /api/test/ingestion-token  { actorId, tenantId }
 * → 201 with { token: "<scoped ingestion JWT>" }
 *
 * The token is signed with the same ephemeral key pair the test server uses,
 * so it can be verified by POST /internal/ingestion/email in the same process.
 *
 * Never enabled in production.
 */
export async function handleTestIngestionTokenRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (!isTestMode()) return null;
  if (req.method !== 'POST' || url.pathname !== '/api/test/ingestion-token') return null;

  const corsHeaders = getCorsHeaders(req);
  try {
    const body = (await req.json().catch(() => ({}))) as { actorId?: string; tenantId?: string };
    if (!body.actorId || !body.tenantId) {
      return new Response(JSON.stringify({ error: 'actorId and tenantId required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const token = await mintIngestionToken({ actorId: body.actorId, tenantId: body.tenantId });
    return new Response(JSON.stringify({ token }), {
      status: 201,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('TEST INGESTION TOKEN ERROR:', err);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

export async function handleTestSessionRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!isTestMode()) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;

  // POST /api/test/embedding-rate-check
  // Calls checkEmbeddingReadRate for the given tenantId and actorId.
  // Returns 200 if allowed, 429 if throttled.
  // Only available in TEST_MODE — never enabled in production.
  if (req.method === 'POST' && url.pathname === '/api/test/embedding-rate-check') {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body: { tenantId?: string } = {};
    try {
      body = await req.json();
    } catch {
      // no body — use defaults
    }

    const tenantId = body.tenantId ?? 'default';
    const actorIp = getClientIp(req);

    const { denyResponse } = await checkEmbeddingReadRate(tenantId, user.id, actorIp, corsHeaders);
    if (denyResponse) return denyResponse;

    return new Response(JSON.stringify({ allowed: true, tenantId, actorId: user.id }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST' || url.pathname !== '/api/test/session') {
    return null;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { username?: string };
    const username = body.username ?? `test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const userId = crypto.randomUUID();

    await sql`
      INSERT INTO entities (id, type, properties, tenant_id)
      VALUES (${userId}, 'user', ${sql.json({ username })}, null)
      ON CONFLICT DO NOTHING
    `;

    // Check if username was already taken (on conflict do nothing means we may
    // have a duplicate username). Re-query to get existing user's id.
    const users = await sql`
      SELECT id FROM entities
      WHERE type = 'user' AND properties->>'username' = ${username}
      LIMIT 1
    `;
    const resolvedUserId = (users[0] as { id: string } | undefined)?.id ?? userId;

    const token = await signJwt({ id: resolvedUserId, username });
    const csrfToken = generateCsrfToken();

    const res = new Response(JSON.stringify({ user: { id: resolvedUserId, username } }), {
      status: 201,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
    res.headers.append('Set-Cookie', authCookieHeader(token));
    res.headers.append('Set-Cookie', csrfCookieHeader(csrfToken));
    return res;
  } catch (err) {
    console.error('TEST SESSION ERROR:', err);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

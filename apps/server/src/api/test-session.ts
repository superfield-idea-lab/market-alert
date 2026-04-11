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
import { getCorsHeaders } from './auth';
import { signJwt } from '../auth/jwt';
import { generateCsrfToken, csrfCookieHeader } from '../auth/csrf';
import { authCookieHeader } from '../auth/cookie-config';

export function isTestMode(): boolean {
  return process.env.TEST_MODE === 'true';
}

export async function handleTestSessionRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  if (!isTestMode()) return null;

  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;

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

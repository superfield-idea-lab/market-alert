/**
 * Re-identification API — sole HTTP boundary for token-to-identity resolution.
 *
 * POST /api/reidentification/resolve
 *   Body: { token: string }
 *   Auth: session cookie (authenticated user) — superuser only.
 *
 * Requires:
 *   - Valid authenticated session (401 if absent).
 *   - Superuser role (403 if not a superuser).
 *   - A non-empty `token` string in the request body (400 if missing).
 *
 * Returns 200 with the resolved identity on success.
 * Returns 404 when no row exists for the given token.
 *
 * Every successful resolution writes an audit event via the service layer.
 * If the audit write fails the response is 500 — no identity is returned.
 *
 * Only superusers may call this endpoint to enforce the tight service boundary
 * described in issue #20. No other route in this server resolves tokens.
 */

import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser } from './auth';
import { isSuperuser, makeJson } from '../lib/response';
import { resolveToken } from '../policies/reidentification-service';

export async function handleReidentificationRequest(
  req: Request,
  url: URL,
  _appState: AppState,
): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/reidentification')) return null;

  const corsHeaders = getCorsHeaders(req);
  const json = makeJson(corsHeaders);

  // POST /api/reidentification/resolve
  if (req.method === 'POST' && url.pathname === '/api/reidentification/resolve') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);
    if (!isSuperuser(user.id)) return json({ error: 'Forbidden' }, 403);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>).token !== 'string' ||
      !(body as Record<string, unknown>).token
    ) {
      return json({ error: 'Missing required field: token' }, 400);
    }

    const token = (body as { token: string }).token;
    const correlationId = req.headers.get('X-Trace-Id') ?? undefined;
    const ip =
      req.headers.get('X-Forwarded-For') ?? req.headers.get('CF-Connecting-IP') ?? undefined;

    try {
      const resolved = await resolveToken({
        token,
        actorId: user.id,
        correlationId,
        ip,
      });

      if (resolved === null) {
        return json({ error: 'Token not found' }, 404);
      }

      return json(resolved, 200);
    } catch (err) {
      console.error('[reidentification] Resolution failed:', err);
      return json({ error: 'Internal Server Error' }, 500);
    }
  }

  return null;
}

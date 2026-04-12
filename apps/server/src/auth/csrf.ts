/**
 * CSRF double-submit cookie protection.
 *
 * On login/register the server mints a random 32-byte hex token and sends it
 * back in a readable (HttpOnly=false) `__Host-csrf-token` cookie. Browser JS
 * must echo that value in the `X-CSRF-Token` request header for every
 * state-mutating method. Because a cross-origin attacker cannot read the
 * cookie (same-origin policy), they cannot forge the header even though the
 * browser auto-sends the cookie.
 *
 * Safe methods (GET, HEAD, OPTIONS) are not checked.
 * `CSRF_DISABLED=true` bypasses the check — use only in test environments or
 * for API-key-authenticated routes.
 */

import { emitAuditEvent } from '../policies/audit-service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_COOKIE_NAME = '__Host-csrf-token';

/**
 * Generate a random 32-byte hex CSRF token.
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the `Set-Cookie` header value for the CSRF token cookie.
 * HttpOnly is intentionally omitted (defaults to false) so browser JS can
 * read the value and include it in the X-CSRF-Token header.
 */
export function csrfCookieHeader(token: string): string {
  return `${CSRF_COOKIE_NAME}=${token}; SameSite=Strict; Secure; Path=/`;
}

/**
 * Verify CSRF protection for a request.
 *
 * Returns a 403 Response when the check fails, or null when the request is
 * allowed to proceed.
 */
export function verifyCsrf(req: Request, cookies: Record<string, string>): Response | null {
  if (process.env.CSRF_DISABLED === 'true') return null;
  if (SAFE_METHODS.has(req.method)) return null;

  const cookieToken = cookies[CSRF_COOKIE_NAME];
  const headerToken = req.headers.get('X-CSRF-Token');

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return new Response(JSON.stringify({ error: 'CSRF token mismatch' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

/**
 * Context for an authenticated actor, used to enrich CSRF failure audit events.
 */
export interface CsrfAuditContext {
  /** The authenticated actor's user ID, or 'anonymous' when unauthenticated. */
  actorId: string;
  /** The URL path of the request, used as the entity_id in the audit event. */
  path: string;
  /** Optional client IP address. */
  ip?: string;
  /** Optional User-Agent string. */
  userAgent?: string;
}

/**
 * Verify CSRF protection for a request and emit an audit event on failure.
 *
 * Behaves identically to `verifyCsrf` but additionally writes a
 * `security.csrf_mismatch` audit event whenever the check fails. The audit
 * write is best-effort — a failure to write does not suppress the 403.
 *
 * Returns a 403 Response when the check fails, or null when the request is
 * allowed to proceed.
 */
export async function verifyCsrfAndAudit(
  req: Request,
  cookies: Record<string, string>,
  ctx: CsrfAuditContext,
): Promise<Response | null> {
  const result = verifyCsrf(req, cookies);
  if (result === null) return null;

  // Emit a best-effort audit event so the failure is traceable in the audit log.
  await emitAuditEvent({
    actor_id: ctx.actorId,
    action: 'security.csrf_mismatch',
    entity_type: 'request',
    entity_id: ctx.path,
    before: null,
    after: {
      method: req.method,
      path: ctx.path,
      reason: !cookies[CSRF_COOKIE_NAME]
        ? 'missing_cookie'
        : !req.headers.get('X-CSRF-Token')
          ? 'missing_header'
          : 'token_mismatch',
    },
    ip: ctx.ip,
    user_agent: ctx.userAgent ?? req.headers.get('User-Agent') ?? undefined,
    ts: new Date().toISOString(),
  }).catch((err) => console.warn('[csrf] audit write failed:', err));

  return result;
}

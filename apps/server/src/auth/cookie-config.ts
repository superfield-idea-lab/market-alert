/**
 * Environment-aware auth cookie configuration.
 *
 * Session cookies are always issued HttpOnly and SameSite=Strict — the required
 * posture for passkey-only authentication per the Phase 1 security foundation
 * requirements (issue #14, AUTH blueprint).
 *
 * When SECURE_COOKIES=true the cookie uses the __Host- prefix and the Secure
 * flag — the correct posture for HTTPS deployments.
 *
 * When SECURE_COOKIES is unset or false, the cookie uses a plain name without
 * the Secure flag — suitable for local development over HTTP.
 *
 * getAuthenticatedUser checks both cookie names so that sessions survive a
 * transition between modes (e.g. deploying HTTPS for the first time).
 */

/** Plain cookie name used in dev mode. */
export const COOKIE_NAME_PLAIN = 'superfield_auth';

/** __Host- prefixed cookie name used in HTTPS mode. */
export const COOKIE_NAME_SECURE = '__Host-superfield_auth';

/** Whether secure cookie mode is active. */
export function isSecureCookies(): boolean {
  return process.env.SECURE_COOKIES === 'true';
}

/** Return the active cookie name for the current environment. */
export function getAuthCookieName(): string {
  return isSecureCookies() ? COOKIE_NAME_SECURE : COOKIE_NAME_PLAIN;
}

/**
 * Build the Set-Cookie header value for the auth JWT token.
 *
 * HTTPS mode: `__Host-superfield_auth=<token>; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=604800`
 * Dev mode:   `superfield_auth=<token>; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`
 *
 * SameSite=Strict is used in both modes to enforce strict session cookie posture
 * as required by the Phase 1 security foundation (issue #14, AUTH blueprint).
 */
export function authCookieHeader(token: string): string {
  if (isSecureCookies()) {
    return `${COOKIE_NAME_SECURE}=${token}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=604800`;
  }
  return `${COOKIE_NAME_PLAIN}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`;
}

/**
 * Build the Set-Cookie header value that clears the auth cookie.
 */
export function authCookieClearHeader(): string {
  if (isSecureCookies()) {
    return `${COOKIE_NAME_SECURE}=; HttpOnly; Secure; Path=/; Max-Age=0`;
  }
  return `${COOKIE_NAME_PLAIN}=; HttpOnly; Path=/; Max-Age=0`;
}

/**
 * Extract the auth token from parsed cookies, checking both cookie names for
 * transition tolerance.
 */
export function getAuthToken(cookies: Record<string, string>): string | undefined {
  const name = getAuthCookieName();
  // Prefer the active name, fall back to the other for transition tolerance
  return cookies[name] || cookies[COOKIE_NAME_PLAIN] || cookies[COOKIE_NAME_SECURE];
}

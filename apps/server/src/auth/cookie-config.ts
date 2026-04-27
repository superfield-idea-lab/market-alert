/**
 * Environment-aware auth cookie configuration.
 *
 * Session cookies are always issued HttpOnly and SameSite=Strict — the correct
 * posture for this application's authentication model and deployment pattern.
 *
 * SameSite=Strict (intentional — issue #228 security decision record):
 *   SameSite=Lax allows cookies on top-level cross-site GET navigations, which
 *   is necessary for OAuth/SSO redirect flows (where an external IdP lands the
 *   user back on an authenticated page). Finance-kb uses passkey-only FIDO2
 *   authentication with no OAuth callbacks, no SAML SSO, and no external redirect
 *   flows. All authentication ceremonies are same-origin (POST to /api/auth/passkey/*).
 *   Users navigate directly to the SPA. SameSite=Strict is therefore the correct
 *   posture and does not break any in-use browser flow.
 *
 *   The template repo (calypso-blueprint) uses SameSite=Lax to accommodate
 *   OAuth/SSO patterns that finance-kb deliberately does not implement.
 *
 *   CSRF posture: finance-kb also enforces double-submit CSRF protection
 *   (__Host-csrf-token, X-CSRF-Token header check in auth/csrf.ts) on all
 *   state-mutating routes. That protection is independent of SameSite and
 *   remains sufficient regardless of this setting. If a future release adds
 *   OAuth/SSO, revisit both this setting and the CSRF controls together.
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
 * SameSite=Strict is used in both modes. See the module-level comment for the
 * full security decision record (issue #228, issue #14, AUTH blueprint).
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

/**
 * Passkey / WebAuthn authentication API handler.
 *
 * Implements two ceremonies using @simplewebauthn/server:
 *
 * Registration:
 *   POST /api/auth/passkey/register/begin   → PublicKeyCredentialCreationOptions
 *   POST /api/auth/passkey/register/complete → verify attestation, store credential
 *
 * Authentication:
 *   POST /api/auth/passkey/login/begin   → PublicKeyCredentialRequestOptions
 *   POST /api/auth/passkey/login/complete → verify assertion, issue JWT
 *
 * Key recovery (AUTH-C-016/017, AUTH-D-007):
 *   POST /api/auth/passkey/recovery/setup    → set recovery passphrase for authenticated user
 *   POST /api/auth/passkey/recovery/begin    → verify passphrase, issue recovery challenge
 *   POST /api/auth/passkey/recovery/complete → verify second factor, re-enroll passkey
 *
 * Challenges are 32-byte random values stored in the passkey_challenges table
 * with a 5-minute TTL. Counter-based clone detection rejects authentication if
 * the presented counter ≤ stored counter.
 *
 * Progressive lockout (AUTH-C-024, AUTH-C-032):
 *   Failed assertions increment a per-user counter with exponential delay.
 *   All error responses are generic — no account-existence leakage.
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { AppState } from '../index';
import { getCorsHeaders, getAuthenticatedUser, parseCookies } from './auth';
import { verifyCsrfAndAudit, generateCsrfToken, csrfCookieHeader } from '../auth/csrf';
import { signJwt } from '../auth/jwt';
import { authCookieHeader } from '../auth/cookie-config';
import { checkLockout, recordFailedAttempt, resetLockout } from 'db/auth-lockout';
import {
  setRecoveryPassphrase,
  checkRecoveryPassphrase,
  revokeOldPasskeys,
  notifyDevicesOfRecovery,
} from 'db/recovery';
import { getClientIp, tenantAuthLimiter, tooManyRequests } from '../security/rate-limiter';
import { emitAuditEvent } from '../policies/audit-service';
import { getUserAccessFlags } from '../lib/access';

// The Relying Party name (display only, not security-critical).
const RP_NAME = process.env.RP_NAME ?? 'Superfield';

// Default fallback values when no request headers or env vars are available.
const DEFAULT_RP_ID = 'localhost';
const DEFAULT_ORIGIN = 'http://localhost:5174';

/**
 * Derive WebAuthn RP ID and origin dynamically from the incoming request.
 *
 * Precedence:
 *   1. Environment variables RP_ID + ORIGIN (both must be set to take effect)
 *   2. Request Origin header
 *   3. Request Referer header
 *   4. Localhost defaults
 *
 * URL parsing errors fall back to localhost defaults.
 */
export function getRpConfig(req: Request): { rpId: string; origin: string } {
  // Env vars take precedence when both are set
  const envRpId = process.env.RP_ID;
  const envOrigin = process.env.ORIGIN;
  if (envRpId && envOrigin) {
    return { rpId: envRpId, origin: envOrigin };
  }

  // Try Origin header first, then Referer
  const headerValue = req.headers.get('origin') ?? req.headers.get('referer');
  if (headerValue) {
    try {
      const parsed = new URL(headerValue);
      return { rpId: parsed.hostname, origin: parsed.origin };
    } catch {
      // URL parsing failed — fall through to defaults
    }
  }

  return { rpId: DEFAULT_RP_ID, origin: DEFAULT_ORIGIN };
}

export async function handlePasskeyRequest(
  req: Request,
  url: URL,
  appState: AppState,
): Promise<Response | null> {
  const corsHeaders = getCorsHeaders(req);
  const { sql } = appState;

  // Preflight
  if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/auth/passkey')) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ------------------------------------------------------------------
  // GET /api/auth/passkey/credentials
  // ------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/auth/passkey/credentials') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401, corsHeaders);

    try {
      const credentials = await sql`
        SELECT id, credential_id, created_at, last_used_at
        FROM passkey_credentials
        WHERE user_id = ${user.id}
        ORDER BY created_at DESC
      `;
      return json(credentials, 200, corsHeaders);
    } catch (err) {
      console.error('PASSKEY CREDENTIALS LIST ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // DELETE /api/auth/passkey/credentials/:id
  // ------------------------------------------------------------------
  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/auth\/passkey\/credentials\/[^/]+$/)) {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401, corsHeaders);

    const credentialId = url.pathname.split('/')[5];

    try {
      const deleted = await sql`
        DELETE FROM passkey_credentials
        WHERE id = ${credentialId}
          AND user_id = ${user.id}
        RETURNING id
      `;
      if (deleted.length === 0) return json({ error: 'Not found' }, 404, corsHeaders);
      return new Response(null, { status: 204, headers: corsHeaders });
    } catch (err) {
      console.error('PASSKEY CREDENTIALS DELETE ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // POST /api/auth/passkey/register/begin
  //
  // Accepts either:
  //   { userId } — add a passkey to an existing authenticated account
  //   { username } — create a new user entity and begin first passkey registration
  //
  // When only a username is provided, a new user entity is created without a
  // password. No password field exists anywhere in the passkey-only auth flow
  // (AUTH blueprint, Phase 1 security foundation, issue #14).
  // ------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/register/begin') {
    try {
      const body = (await req.json()) as { userId?: string; username?: string };
      let resolvedUserId: string;
      let resolvedUsername: string;

      if (body.userId) {
        // Existing user — look up by id
        const users = await sql`
          SELECT id, properties->>'username' AS username
          FROM entities
          WHERE id = ${body.userId} AND type = 'user'
        `;
        if (users.length === 0) {
          return json({ error: 'User not found' }, 404, corsHeaders);
        }
        const u = users[0] as { id: string; username: string };
        resolvedUserId = u.id;
        resolvedUsername = u.username;
      } else if (body.username) {
        // New user registration — check username is not taken
        const existing = await sql`
          SELECT id FROM entities
          WHERE type = 'user' AND properties->>'username' = ${body.username}
        `;
        if (existing.length > 0) {
          return json({ error: 'Username already taken' }, 409, corsHeaders);
        }
        // Create a new user entity without a password hash.
        // Authentication is solely via passkey; no password field is stored.
        const newId = crypto.randomUUID();
        await sql`
          INSERT INTO entities (id, type, properties, tenant_id)
          VALUES (${newId}, 'user', ${sql.json({ username: body.username })}, null)
        `;
        resolvedUserId = newId;
        resolvedUsername = body.username;
      } else {
        return json({ error: 'userId or username required' }, 400, corsHeaders);
      }

      const userId = resolvedUserId;
      const user = { id: resolvedUserId, username: resolvedUsername };

      // Fetch existing credentials so the browser can exclude them
      const existingCreds = await sql`
        SELECT credential_id FROM passkey_credentials WHERE user_id = ${userId}
      `;
      const excludeCredentials = (existingCreds as unknown as { credential_id: string }[]).map(
        (row) => ({ id: row.credential_id }),
      );

      const { rpId } = getRpConfig(req);

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rpId,
        userName: user.username,
        userDisplayName: user.username,
        excludeCredentials,
        authenticatorSelection: {
          residentKey: 'preferred',
          userVerification: 'preferred',
        },
        timeout: 60_000,
      });

      // Persist the challenge
      await sql`
        INSERT INTO passkey_challenges (user_id, challenge, type)
        VALUES (${userId}, ${options.challenge}, 'registration')
      `;

      // Return the options and the resolved userId so the client can pass it
      // back in the register/complete request.
      return json({ ...options, _userId: userId }, 200, corsHeaders);
    } catch (err) {
      console.error('PASSKEY REGISTER BEGIN ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // POST /api/auth/passkey/register/complete
  // ------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/register/complete') {
    // CSRF guard applies only when there is an existing authenticated session
    // (i.e. adding a passkey to an already-logged-in account). New user
    // registrations have no session cookie yet, so the double-submit pattern
    // cannot apply. In that case, the attestation itself is the only required
    // proof of origin.
    const cookies = parseCookies(req.headers.get('Cookie'));
    const hasSession = await getAuthenticatedUser(req);
    if (hasSession) {
      const csrfError = await verifyCsrfAndAudit(req, cookies, {
        actorId: hasSession.id,
        path: url.pathname,
      });
      if (csrfError)
        return new Response(csrfError.body, {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    try {
      const { userId, response } = (await req.json()) as {
        userId: string;
        response: RegistrationResponseJSON;
      };

      if (!userId || !response) {
        return json({ error: 'userId and response required' }, 400, corsHeaders);
      }

      // Retrieve unexpired challenge for this user
      const challengeRows = await sql`
        SELECT id, challenge FROM passkey_challenges
        WHERE user_id = ${userId}
          AND type = 'registration'
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (challengeRows.length === 0) {
        return json({ error: 'No valid challenge found' }, 400, corsHeaders);
      }
      const challengeRow = challengeRows[0] as { id: string; challenge: string };

      // Delete the challenge immediately (single-use)
      await sql`DELETE FROM passkey_challenges WHERE id = ${challengeRow.id}`;

      const { rpId, origin: rpOrigin } = getRpConfig(req);

      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: rpOrigin,
        expectedRPID: rpId,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return json({ error: 'Registration verification failed' }, 400, corsHeaders);
      }

      const { credential, aaguid } = verification.registrationInfo;

      // Store the credential, return the persisted credential_id
      const inserted = await sql`
        INSERT INTO passkey_credentials
          (user_id, credential_id, public_key, counter, aaguid, transports)
        VALUES (
          ${userId},
          ${credential.id},
          ${Buffer.from(credential.publicKey)},
          ${credential.counter},
          ${aaguid ?? ''},
          ${credential.transports ?? []}
        )
        RETURNING credential_id
      `;
      const credentialId = (inserted[0] as { credential_id: string }).credential_id;

      // Look up the user's username so we can issue a session JWT.
      // This means a successful passkey registration also logs the user in,
      // eliminating any need for a separate password-based login step.
      const userRows = await sql`
        SELECT properties->>'username' AS username
        FROM entities
        WHERE id = ${userId} AND type = 'user'
        LIMIT 1
      `;
      const username = (userRows[0] as { username: string } | undefined)?.username ?? '';
      const sessionToken = await signJwt({ id: userId, username });
      const csrfToken = generateCsrfToken();

      const access = await getUserAccessFlags(userId, sql).catch(() => ({
        isSuperadmin: false,
        isCrmAdmin: false,
        isComplianceOfficer: false,
      }));
      const regRes = new Response(
        JSON.stringify({
          verified: true,
          credentialId,
          user: {
            id: userId,
            username,
            isSuperadmin: access.isSuperadmin,
            isCrmAdmin: access.isCrmAdmin,
            isComplianceOfficer: access.isComplianceOfficer,
          },
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
      regRes.headers.append('Set-Cookie', authCookieHeader(sessionToken));
      regRes.headers.append('Set-Cookie', csrfCookieHeader(csrfToken));
      return regRes;
    } catch (err) {
      console.error('PASSKEY REGISTER COMPLETE ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // POST /api/auth/passkey/login/begin
  //
  // Tenant-aware auth rate limit (issue #89):
  //   Per-actor-IP, per-tenant-domain burst throttle. The tenant is identified
  //   by the WebAuthn RP ID (the relying party domain), which is the natural
  //   tenant boundary for passkey authentication.
  //   Audit-before-deny: a throttle decision writes an audit event before the
  //   429 response is returned.
  // ------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/login/begin') {
    // Apply tenant-aware auth rate limit before any DB work
    const { rpId: loginRpId } = getRpConfig(req);
    const loginActorIp = getClientIp(req);
    const loginRateResult = tenantAuthLimiter.check(loginRpId, loginActorIp);
    if (!loginRateResult.allowed) {
      // Audit-before-deny: record the throttle event before returning 429
      await emitAuditEvent({
        actor_id: loginActorIp,
        action: 'auth.rate_limit.throttled',
        entity_type: 'auth',
        entity_id: loginRpId,
        before: null,
        after: {
          endpoint: '/api/auth/passkey/login/begin',
          tenant: loginRpId,
          actor_ip: loginActorIp,
          limit: loginRateResult.limit,
          reset_at: loginRateResult.resetAt,
        },
        ip: loginActorIp,
        ts: new Date().toISOString(),
      }).catch((err) => {
        // Audit failure must not suppress the rate-limit response
        console.error('[rate-limit] audit emit failed:', err);
      });
      return tooManyRequests(loginRateResult, corsHeaders);
    }
    tenantAuthLimiter.consume(loginRpId, loginActorIp);

    try {
      const body = (await req.json().catch(() => ({}))) as { userId?: string };
      const userId = body.userId;

      let allowCredentials: { id: string }[] = [];

      if (userId) {
        const creds = await sql`
          SELECT credential_id FROM passkey_credentials WHERE user_id = ${userId}
        `;
        allowCredentials = (creds as unknown as { credential_id: string }[]).map((row) => ({
          id: row.credential_id,
        }));
      }

      const { rpId } = getRpConfig(req);

      const options = await generateAuthenticationOptions({
        rpID: rpId,
        allowCredentials,
        userVerification: 'preferred',
        timeout: 60_000,
      });

      // Store challenge — user_id may be null for discoverable credential flows
      await sql`
        INSERT INTO passkey_challenges (user_id, challenge, type)
        VALUES (${userId ?? null}, ${options.challenge}, 'authentication')
      `;

      return json(options, 200, corsHeaders);
    } catch (err) {
      console.error('PASSKEY LOGIN BEGIN ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // POST /api/auth/passkey/login/complete
  //
  // Progressive lockout (AUTH-C-024, AUTH-C-032):
  //   Failed attempts increment a per-user exponential delay counter.
  //   All error responses are generic — no account-existence leakage.
  //
  // Tenant-aware auth rate limit (issue #89):
  //   Same window as login/begin — each ceremony step consumes one slot.
  //   Enforced here as well so clients that skip /begin are still bounded.
  // ------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/login/complete') {
    // Apply tenant-aware auth rate limit before any DB work
    const { rpId: completeRpId } = getRpConfig(req);
    const completeActorIp = getClientIp(req);
    const completeRateResult = tenantAuthLimiter.check(completeRpId, completeActorIp);
    if (!completeRateResult.allowed) {
      await emitAuditEvent({
        actor_id: completeActorIp,
        action: 'auth.rate_limit.throttled',
        entity_type: 'auth',
        entity_id: completeRpId,
        before: null,
        after: {
          endpoint: '/api/auth/passkey/login/complete',
          tenant: completeRpId,
          actor_ip: completeActorIp,
          limit: completeRateResult.limit,
          reset_at: completeRateResult.resetAt,
        },
        ip: completeActorIp,
        ts: new Date().toISOString(),
      }).catch((err) => {
        console.error('[rate-limit] audit emit failed:', err);
      });
      return tooManyRequests(completeRateResult, corsHeaders);
    }
    tenantAuthLimiter.consume(completeRpId, completeActorIp);

    try {
      const { response } = (await req.json()) as { response: AuthenticationResponseJSON };

      if (!response) {
        // Generic error — do not reveal whether credential exists (AUTH-C-032)
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }

      // Look up the credential by credential ID
      const credRows = await sql`
        SELECT pc.id, pc.user_id, pc.credential_id, pc.public_key, pc.counter, pc.transports,
               e.properties->>'username' AS username
        FROM passkey_credentials pc
        JOIN entities e ON e.id = pc.user_id
        WHERE pc.credential_id = ${response.id}
        LIMIT 1
      `;
      if (credRows.length === 0) {
        // Generic error — do not reveal whether the credential or account exists
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }
      const cred = credRows[0] as {
        id: string;
        user_id: string;
        credential_id: string;
        public_key: Buffer;
        counter: number;
        transports: string[];
        username: string;
      };

      // Progressive lockout check — must happen before challenge consumption
      // so a locked-out user cannot drain challenges (AUTH-C-024).
      const lockoutState = await checkLockout(cred.user_id);
      if (lockoutState.blocked) {
        return new Response(JSON.stringify({ error: 'Authentication failed' }), {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(lockoutState.retryAfterSeconds),
          },
        });
      }

      // Retrieve unexpired authentication challenge
      const challengeRows = await sql`
        SELECT id, challenge FROM passkey_challenges
        WHERE type = 'authentication'
          AND expires_at > NOW()
          AND (user_id = ${cred.user_id} OR user_id IS NULL)
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (challengeRows.length === 0) {
        await recordFailedAttempt(cred.user_id);
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }
      const challengeRow = challengeRows[0] as { id: string; challenge: string };

      // Delete challenge immediately (single-use)
      await sql`DELETE FROM passkey_challenges WHERE id = ${challengeRow.id}`;

      const { rpId, origin: rpOrigin } = getRpConfig(req);

      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: rpOrigin,
        expectedRPID: rpId,
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: cred.transports as AuthenticatorTransport[],
        },
        requireUserVerification: false,
      });

      if (!verification.verified) {
        await recordFailedAttempt(cred.user_id);
        // Generic error — do not reveal credential or account details (AUTH-C-032)
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }

      const newCounter = verification.authenticationInfo.newCounter;

      // Counter-based clone detection: reject if new counter ≤ stored counter
      if (newCounter <= cred.counter && newCounter !== 0) {
        await recordFailedAttempt(cred.user_id);
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }

      // Update counter and last_used_at
      await sql`
        UPDATE passkey_credentials
        SET counter = ${newCounter}, last_used_at = NOW()
        WHERE id = ${cred.id}
      `;

      // Successful authentication — reset the lockout counter
      await resetLockout(cred.user_id);

      // Issue JWT and session cookie with HttpOnly, Secure (in HTTPS mode), SameSite=Strict.
      // CSRF token is issued alongside so the browser can attach it to subsequent
      // state-mutating requests (passkey management, logout, etc.).
      const token = await signJwt({ id: cred.user_id, username: cred.username });
      const csrfToken = generateCsrfToken();

      const access = await getUserAccessFlags(cred.user_id, sql).catch(() => ({
        isSuperadmin: false,
        isCrmAdmin: false,
        isComplianceOfficer: false,
      }));
      const loginRes = new Response(
        JSON.stringify({
          user: {
            id: cred.user_id,
            username: cred.username,
            isSuperadmin: access.isSuperadmin,
            isCrmAdmin: access.isCrmAdmin,
            isComplianceOfficer: access.isComplianceOfficer,
          },
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      );
      loginRes.headers.append('Set-Cookie', authCookieHeader(token));
      loginRes.headers.append('Set-Cookie', csrfCookieHeader(csrfToken));
      return loginRes;
    } catch (err) {
      console.error('PASSKEY LOGIN COMPLETE ERROR:', err);
      return json({ error: 'Authentication failed' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // POST /api/auth/passkey/recovery/setup
  //
  // Store a recovery passphrase for the authenticated user (AUTH-C-016).
  // Requires an active session.
  // ------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/recovery/setup') {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401, corsHeaders);

    // CSRF guard — user is authenticated so double-submit applies
    const cookies = parseCookies(req.headers.get('Cookie'));
    const csrfError = await verifyCsrfAndAudit(req, cookies, {
      actorId: user.id,
      path: url.pathname,
    });
    if (csrfError) return csrfError;

    try {
      const body = (await req.json()) as { passphrase?: string };
      if (!body.passphrase || typeof body.passphrase !== 'string' || body.passphrase.length < 16) {
        return json({ error: 'passphrase must be at least 16 characters' }, 400, corsHeaders);
      }
      await setRecoveryPassphrase(user.id, body.passphrase);
      return json({ ok: true }, 200, corsHeaders);
    } catch (err) {
      console.error('RECOVERY SETUP ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // POST /api/auth/passkey/recovery/begin
  //
  // First factor: verify recovery passphrase, issue a recovery challenge
  // that the client must satisfy with a WebAuthn second factor.
  // No session cookie is required — the user is locked out of their passkey.
  // ------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/recovery/begin') {
    try {
      const body = (await req.json()) as { userId?: string; passphrase?: string };
      if (!body.userId || !body.passphrase) {
        return json({ error: 'Authentication failed' }, 400, corsHeaders);
      }

      // Verify the recovery passphrase (first factor)
      const passphraseOk = await checkRecoveryPassphrase(body.userId, body.passphrase);
      if (!passphraseOk) {
        // Generic error — do not reveal whether account or passphrase exists
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }

      // Generate a WebAuthn challenge for the second factor (any enrolled credential).
      const existingCreds = await sql`
        SELECT credential_id FROM passkey_credentials WHERE user_id = ${body.userId}
      `;
      const allowCredentials = (existingCreds as unknown as { credential_id: string }[]).map(
        (row) => ({ id: row.credential_id }),
      );

      const { rpId } = getRpConfig(req);
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        allowCredentials,
        userVerification: 'preferred',
        timeout: 60_000,
      });

      // Store the challenge with type='recovery'
      await sql`
        INSERT INTO passkey_challenges (user_id, challenge, type)
        VALUES (${body.userId}, ${options.challenge}, 'recovery')
      `;

      return json(options, 200, corsHeaders);
    } catch (err) {
      console.error('RECOVERY BEGIN ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  // ------------------------------------------------------------------
  // POST /api/auth/passkey/recovery/complete
  //
  // Second factor: verify WebAuthn assertion against the recovery challenge,
  // then re-enroll a new passkey (provided as a registration response),
  // revoke all old passkeys, and notify enrolled devices (AUTH-C-016/017).
  // ------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/auth/passkey/recovery/complete') {
    try {
      const body = (await req.json()) as {
        userId?: string;
        assertionResponse?: AuthenticationResponseJSON;
        registrationResponse?: RegistrationResponseJSON;
      };

      if (!body.userId || !body.assertionResponse || !body.registrationResponse) {
        return json({ error: 'Authentication failed' }, 400, corsHeaders);
      }

      // Look up the credential used for the second-factor assertion
      const credRows = await sql`
        SELECT pc.id, pc.user_id, pc.credential_id, pc.public_key, pc.counter, pc.transports
        FROM passkey_credentials pc
        WHERE pc.credential_id = ${body.assertionResponse.id}
          AND pc.user_id = ${body.userId}
        LIMIT 1
      `;
      if (credRows.length === 0) {
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }
      const cred = credRows[0] as {
        id: string;
        user_id: string;
        credential_id: string;
        public_key: Buffer;
        counter: number;
        transports: string[];
      };

      // Retrieve the unexpired recovery challenge
      const challengeRows = await sql`
        SELECT id, challenge FROM passkey_challenges
        WHERE type = 'recovery'
          AND user_id = ${body.userId}
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (challengeRows.length === 0) {
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }
      const challengeRow = challengeRows[0] as { id: string; challenge: string };

      // Consume the challenge immediately (single-use)
      await sql`DELETE FROM passkey_challenges WHERE id = ${challengeRow.id}`;

      const { rpId, origin: rpOrigin } = getRpConfig(req);

      // Verify the second-factor assertion
      const assertionVerification = await verifyAuthenticationResponse({
        response: body.assertionResponse,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: rpOrigin,
        expectedRPID: rpId,
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: cred.transports as AuthenticatorTransport[],
        },
        requireUserVerification: true,
      });

      if (!assertionVerification.verified) {
        return json({ error: 'Authentication failed' }, 401, corsHeaders);
      }

      // Verify the new passkey registration (re-enrollment)
      // The registration challenge was the same challenge value embedded in
      // the registration options generated by the client via its own begin call.
      // For recovery, the client must have already obtained a registration
      // challenge from /register/begin using the same userId.
      const regChallengeRows = await sql`
        SELECT id, challenge FROM passkey_challenges
        WHERE type = 'registration'
          AND user_id = ${body.userId}
          AND expires_at > NOW()
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (regChallengeRows.length === 0) {
        return json(
          { error: 'No valid registration challenge — call register/begin first' },
          400,
          corsHeaders,
        );
      }
      const regChallengeRow = regChallengeRows[0] as { id: string; challenge: string };
      await sql`DELETE FROM passkey_challenges WHERE id = ${regChallengeRow.id}`;

      const regVerification = await verifyRegistrationResponse({
        response: body.registrationResponse,
        expectedChallenge: regChallengeRow.challenge,
        expectedOrigin: rpOrigin,
        expectedRPID: rpId,
      });

      if (!regVerification.verified || !regVerification.registrationInfo) {
        return json({ error: 'Authentication failed' }, 400, corsHeaders);
      }

      const { credential: newCred, aaguid } = regVerification.registrationInfo;

      // Insert the new credential
      await sql`
        INSERT INTO passkey_credentials
          (user_id, credential_id, public_key, counter, aaguid, transports)
        VALUES (
          ${body.userId},
          ${newCred.id},
          ${Buffer.from(newCred.publicKey)},
          ${newCred.counter},
          ${aaguid ?? ''},
          ${newCred.transports ?? []}
        )
      `;

      // Revoke all old passkeys except the new one (AUTH-C-016)
      await revokeOldPasskeys(body.userId, newCred.id);

      // Out-of-band notification to all enrolled devices (AUTH-C-017)
      await notifyDevicesOfRecovery(body.userId);

      // Reset any lockout state
      await resetLockout(body.userId);

      // Issue a new session token
      const userRows = await sql`
        SELECT properties->>'username' AS username
        FROM entities
        WHERE id = ${body.userId} AND type = 'user'
        LIMIT 1
      `;
      const username = (userRows[0] as { username: string } | undefined)?.username ?? '';
      const sessionToken = await signJwt({ id: body.userId, username });
      const csrfToken = generateCsrfToken();

      const recoveryRes = new Response(
        JSON.stringify({
          verified: true,
          credentialId: newCred.id,
          user: { id: body.userId, username },
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
      recoveryRes.headers.append('Set-Cookie', authCookieHeader(sessionToken));
      recoveryRes.headers.append('Set-Cookie', csrfCookieHeader(csrfToken));
      return recoveryRes;
    } catch (err) {
      console.error('RECOVERY COMPLETE ERROR:', err);
      return json({ error: 'Internal Server Error' }, 500, corsHeaders);
    }
  }

  return null;
}

/** Convenience helper for JSON responses. */
function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

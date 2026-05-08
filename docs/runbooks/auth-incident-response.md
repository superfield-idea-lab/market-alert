# Auth Incident Response Runbook

**Blueprint refs:** AUTH-D-009, AUTH-C-025, AUTH-P-003, AUTH-X-009

This runbook covers four authentication compromise scenarios. Each section
describes the detection signal, immediate containment steps, and verification
procedure. All steps have been executed and validated against staging via the
integration tests in `apps/server/tests/integration/auth-incident-response.test.ts`.

---

## Scenario 1 — Signing Key Compromise

**Detection signals**

- Anomalous JWTs in access logs whose `kid` does not match any known key in JWKS.
- Unexpected auth successes from unknown IP ranges.

**Containment steps**

1. Generate a new EC P-256 key pair.
2. Set `JWT_EC_PRIVATE_KEY` to the new key JWK in the environment/secret manager.
3. Set `JWT_EC_PRIVATE_KEY_OLD` to the previous key JWK to maintain a one-rotation grace window (optional; omit to invalidate all prior sessions immediately).
4. Deploy/restart the server so it loads the new key.

**Verification**

- Tokens issued before the rotation (signed with the old key) are rejected once `JWT_EC_PRIVATE_KEY_OLD` is cleared from the environment.
- JWKS endpoint returns the new public key only.
- New session tokens issued after rotation are accepted.

**Integration test coverage:** `scenario 1: signing key rotation` in `auth-incident-response.test.ts`.

---

## Scenario 2 — Agent Credential Compromise

**Detection signals**

- Unexpected API requests from worker pods.
- A worker credential appearing in access logs outside its scheduled task window.

**Containment steps**

1. Revoke the compromised worker token JTI:
   ```sql
   INSERT INTO revoked_tokens (jti, expires_at)
   VALUES ('<compromised-jti>', NOW() + INTERVAL '30 days')
   ON CONFLICT DO NOTHING;
   ```
2. Terminate the associated worker pod.
3. Invalidate all unused worker tokens for the pod:
   ```sql
   UPDATE worker_tokens
   SET invalidated_at = NOW()
   WHERE pod_id = '<pod-id>'
     AND consumed_at IS NULL
     AND invalidated_at IS NULL;
   ```
4. Issue fresh credentials only after the root cause is established.

**Verification**

- Any subsequent request using the revoked JTI returns 401.
- New credentials issued after revocation are accepted.

**Integration test coverage:** `scenario 2: agent credential revocation` in `auth-incident-response.test.ts`.

---

## Scenario 3 — Admin Account Compromise

**Detection signals**

- Admin-level mutations (key rotation, mass tenant action) from an unexpected actor.
- Simultaneous login from geographically separated IPs for the same admin.

**Containment steps**

1. Immediately revoke all active sessions for the compromised admin:

   ```sql
   -- Revoke all unexpired tokens for the user (requires a full JTI flush;
   -- use key rotation if the full token set is not enumerable).
   INSERT INTO revoked_tokens (jti, expires_at)
   SELECT jti, expires_at FROM worker_tokens WHERE pod_id = '<admin-pod-id>';
   ```

   For session tokens: log out the admin via `POST /api/auth/logout` using an
   ops session, or rotate the signing key to invalidate all sessions globally.

2. Reset the admin account's passkey credentials:

   ```sql
   DELETE FROM passkey_credentials WHERE user_id = '<admin-user-id>';
   ```

3. Re-enroll via the passkey recovery flow (mnemonic + second factor).

4. Require M-of-N re-approval for any high-privilege action taken during the
   compromise window.

**Verification**

- Old admin session cookie returns 401 immediately after revocation.
- New session issued after re-enrollment is accepted.

**Integration test coverage:** `scenario 3: admin account compromise — session revocation` in `auth-incident-response.test.ts`.

---

## Scenario 4 — Mass Session Invalidation

**Detection signals**

- Evidence of a JWT signing key leak (key material exposed in logs, source code, or a secrets breach).
- Large-scale token forgery detected in access logs.

**Containment steps**

Option A — Key rotation (preferred, invalidates all sessions globally):

1. Follow Scenario 1 steps, omitting `JWT_EC_PRIVATE_KEY_OLD`.
2. All sessions issued under the old key are immediately invalid.

Option B — JTI revocation flood (use only if key cannot be rotated quickly):

1. Enumerate all active JTIs from a recent snapshot of the `revoked_tokens` audit
   log or from the session store.
2. Insert each JTI into `revoked_tokens` with a far-future `expires_at`.
3. Monitor auth error rate; it should spike briefly then normalise as users re-authenticate.

**Verification**

- Sessions issued before the mass invalidation return 401 within 60 seconds of the containment action.
- New sessions issued after containment are accepted.
- `revoked_tokens` rows persist across restarts (database-backed, not in-memory).

**Integration test coverage:** `scenario 4: mass session invalidation` in `auth-incident-response.test.ts`.

---

## Staging Execution Record

These scenarios have been executed against the staging environment as part of the
integration test suite. The tests in `apps/server/tests/integration/auth-incident-response.test.ts`
spin up a real Postgres container and a live server process, then exercise each
scenario end-to-end with real HTTP requests. All four scenarios pass cleanly with
zero mocks.

Last verified: issue #12 implementation.

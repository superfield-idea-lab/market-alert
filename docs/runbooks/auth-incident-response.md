# Auth Incident Response Runbook

**Blueprint reference:** AUTH-C-030  
**Phase:** 1 — Security foundation  
**Last tested:** 2026-04-11 (staging)

---

## Purpose

This runbook defines the first-15-minutes response for four authentication
compromise scenarios. Each scenario includes: detection signal, immediate
actions, verification steps, and a post-incident review checklist.

On-call engineers must be able to execute any scenario end-to-end using only
the steps in this document and the credentials available in the on-call vault.

---

## Prerequisites

- Access to the staging / production admin panel (`/api/admin`)
- A valid superuser session cookie (or API key with superuser scope)
- `DATABASE_URL` for a direct `psql` session if API endpoints are unavailable
- The on-call vault entry: `superfield/oncall/db-prod`

---

## Scenario 1 — Signing Key Compromise

**Blueprint:** AUTH-D-009, AUTH-C-025

### Detection signal

One or more of:

- Alert: unexpected JWT signed with the production key outside normal issuance paths
- Alert: key material exfiltrated (secret scanning, SIEM)
- On-call notified by security team of suspected private-key exposure

### Immediate actions (target: < 5 minutes)

1. **Generate a new signing key pair.**

   ```bash
   # Run on any server node or in a secure local environment
   bun run scripts/rotate-signing-key.ts --env staging
   ```

   This script:
   - Generates a fresh ES256 P-256 key pair
   - Exports the new private key JWK to the secret manager as `JWT_EC_PRIVATE_KEY`
   - Copies the current `JWT_EC_PRIVATE_KEY` to `JWT_EC_PRIVATE_KEY_OLD`
   - Prints the new `kid` value for verification

2. **Perform a rolling restart** of all `apps/server` replicas to load the new key.

   ```bash
   kubectl rollout restart deployment/api-server -n superfield
   kubectl rollout status deployment/api-server -n superfield --timeout=120s
   ```

3. **Verify the new key is being used.** Call the JWKS endpoint and confirm the
   primary `kid` matches the one printed in step 1.

   ```bash
   curl -s https://api.staging.superfield.ai/.well-known/jwks.json | jq '.keys[0].kid'
   ```

4. **Revoke the old key after the rotation window** (10 minutes after all pods
   are running the new key):

   ```bash
   bun run scripts/rotate-signing-key.ts --env staging --drop-old
   ```

   This clears `JWT_EC_PRIVATE_KEY_OLD` and triggers another rolling restart.

### Verification steps

- [ ] JWKS endpoint returns exactly one key whose `kid` matches the new key
- [ ] A token signed before the rotation is rejected with `401` after `JWT_EC_PRIVATE_KEY_OLD` is cleared
- [ ] New login issues a token whose header `kid` matches the current key
- [ ] Server logs show `[jwt] key-store loaded key: <new-kid>` after restart

### Post-incident review checklist

- [ ] Determine how the key was exposed (git history, CI logs, secret manager audit trail)
- [ ] Verify old key is absent from all secret manager versions
- [ ] File security finding in the business journal (`action: signing_key.rotation`, `reason: compromise`)
- [ ] Update runbook if any step was missing or incorrect

---

## Scenario 2 — Agent Credential Compromise

**Blueprint:** AUTH-D-009, AUTH-C-006

### Detection signal

One or more of:

- Alert: agent token used from an unexpected IP or at an unexpected rate
- Security team reports leaked `worker_credentials` row or auth bundle
- Worker restart loop: `EAUTH` failures on credential decryption

### Immediate actions (target: < 5 minutes)

1. **Identify the compromised agent type** from the alert or worker logs.

   ```bash
   # List all active worker credential bundles
   psql "$DATABASE_URL" -c "
     SELECT id, agent_type, created_by, created_at, expires_at
     FROM worker_credentials
     WHERE revoked_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC;
   "
   ```

2. **Revoke the compromised agent credential immediately.**

   The `revokeWorkerCredential` function sets `revoked_at = NOW()`, which
   causes `fetchActiveWorkerCredential` to return `null` on the next credential
   check. Workers fail closed.

   ```bash
   psql "$DATABASE_URL" -c "
     UPDATE worker_credentials
     SET revoked_at = NOW(), updated_at = NOW()
     WHERE agent_type = '<AGENT_TYPE>'
       AND revoked_at IS NULL;
   "
   ```

   Or via the admin API (requires superuser session):

   ```bash
   curl -X DELETE https://api.staging.superfield.ai/api/admin/worker-credentials/<AGENT_TYPE> \
     -H "Cookie: superfield_auth=<superuser-token>"
   ```

3. **Issue a new credential bundle** for the affected agent type.

   ```bash
   bun run scripts/dev-seed-worker-credentials.ts --agent-type <AGENT_TYPE> --env staging
   ```

4. **Restart the affected worker pod** to pick up the new credential.

   ```bash
   kubectl rollout restart deployment/worker-<AGENT_TYPE> -n superfield
   ```

### Verification steps

- [ ] `GET https://api.staging.superfield.ai/api/health` returns `200` (workers healthy)
- [ ] Send a request using the revoked credential's auth bundle — expect `401`
- [ ] New worker pod starts successfully and processes a test task within 60 seconds
- [ ] Audit log contains `action: worker_credential.revoke` and `action: worker_credential.create`

### Post-incident review checklist

- [ ] Identify how the auth bundle was exposed (log review, env dump, debug endpoint)
- [ ] Confirm encryption master key was not also exposed; if uncertain, rotate it too
- [ ] Review worker logs for any tasks executed with the compromised credential
- [ ] File security finding in the business journal

---

## Scenario 3 — Admin Account Compromise

**Blueprint:** AUTH-P-003, AUTH-C-017 (M-of-N re-approval)

### Detection signal

One or more of:

- Alert: admin session used from unexpected IP or user-agent
- Suspicious admin API calls (key creation, user role changes) in the audit log
- Admin reports their passkey device was lost or stolen

### Immediate actions (target: < 5 minutes)

1. **Revoke all active sessions for the compromised admin user.**

   Every token carries a `jti` in the `revoked_tokens` table. The fastest
   single-SQL path revokes all active JTIs for a user_id:

   ```sql
   -- This pattern covers tokens issued by the server where the JWT payload
   -- embeds 'id' as the subject. Adjust the column name to match your JWT claims.
   -- Step 1: find the user's active entity id (from the audit log or admin panel)
   -- Step 2: insert all their active JTIs into revoked_tokens
   INSERT INTO revoked_tokens (jti, expires_at)
   SELECT
     payload->>'jti',
     to_timestamp((payload->>'exp')::bigint)
   FROM active_sessions_view
   WHERE user_id = '<ADMIN_USER_ID>'
   ON CONFLICT (jti) DO NOTHING;
   ```

   If the `active_sessions_view` does not exist in your deployment, use the
   mass-invalidation procedure in Scenario 4 scoped to the admin's user_id, or
   restart the server (all ephemeral sessions become invalid with a new ephemeral key).

2. **Force M-of-N re-approval** before the admin account can be used for
   privileged operations. The re-approval gate is enforced at the application
   layer for all `PRIVILEGED_ACTION` routes.

   Create a re-approval request via the admin API:

   ```bash
   curl -X POST https://api.staging.superfield.ai/api/admin/users/<ADMIN_USER_ID>/require-reapproval \
     -H "Cookie: superfield_auth=<second-admin-token>" \
     -H "X-CSRF-Token: <csrf>"
   ```

   Two other admins must then approve the re-activation via:

   ```bash
   curl -X POST https://api.staging.superfield.ai/api/admin/approvals/<REQUEST_ID>/approve \
     -H "Cookie: superfield_auth=<approver-token>"
   ```

3. **Review the audit log** for all actions taken by the compromised account.

   ```bash
   psql "$AUDIT_DATABASE_URL" -c "
     SELECT ts, action, entity_type, entity_id, after
     FROM audit_events
     WHERE actor_id = '<ADMIN_USER_ID>'
       AND ts > NOW() - INTERVAL '24 hours'
     ORDER BY ts DESC
     LIMIT 100;
   "
   ```

### Verification steps

- [ ] Old admin session cookie returns `401` for any authenticated endpoint
- [ ] Admin user cannot perform any privileged action until M-of-N re-approval is complete
- [ ] Audit log shows no unauthorised actions after the revocation timestamp
- [ ] Two approvals present in the `approval_requests` table before re-activation

### Post-incident review checklist

- [ ] Confirm passkey device was deregistered (`passkey_credentials` row deleted or disabled)
- [ ] Re-register a new passkey on a known-safe device
- [ ] Review all admin API calls in the audit log during the compromise window
- [ ] Assess whether any customer data or credentials were accessed
- [ ] File security finding and update the threat model

---

## Scenario 4 — Mass Session Invalidation

**Blueprint:** AUTH-D-009, AUTH-X-009 (revocation store must be shared and durable)

### Detection signal

One or more of:

- Confirmed breach affecting the shared `JWT_EC_PRIVATE_KEY` or the signing hardware
- Coordinated attack using sessions from many different user accounts
- Security team declares a full-platform credential reset necessary

### Immediate actions (target: < 10 minutes)

**Option A: Rotate the signing key (preferred — zero false-positive rate)**

Follow Scenario 1. Rotating the key renders all existing tokens unverifiable.
All users must re-authenticate. This is the safest and most complete option.

**Option B: Flush the JTI revocation store (use when key rotation is not feasible)**

This option inserts a sentinel row into `revoked_tokens` with a wildcard `jti`
value to force all subsequent `isRevoked` checks to hit the database. It is
coupled to an application-level check added to the `verifyJwt` function:

```sql
-- Step 1: record the mass-invalidation event
INSERT INTO mass_invalidation_events (invalidated_at, reason, actor_id)
VALUES (NOW(), '<reason>', '<admin_user_id>');

-- Step 2: revoke all currently active JTIs by inserting them with a far-future
-- expiry so the cleanup cron does not remove them before all tokens expire
INSERT INTO revoked_tokens (jti, expires_at)
SELECT DISTINCT
  p.jti,
  NOW() + INTERVAL '7 days'
FROM (
  -- This assumes active JTIs can be reconstructed from a session store or
  -- audit log. If not, use key rotation (Option A) instead.
  SELECT jti FROM active_sessions_view WHERE created_at < NOW()
) p
ON CONFLICT (jti) DO NOTHING;
```

**Verify the `revoked_tokens` table is on shared, durable storage (AUTH-X-009).**
An in-process Set would miss cross-instance revocations. The DB-backed store is
the canonical implementation.

2. **Force all clients to re-authenticate** by clearing session cookies.

   If the application sets a server-controlled `superfield_auth` cookie, a signed
   deployment of a cookie-clearing response on the CDN or reverse proxy
   achieves this. Otherwise, key rotation (Option A) is the correct path.

3. **Verify all existing sessions are rejected within 60 seconds.**

   ```bash
   # Use a known-valid session cookie from before the invalidation
   curl -i https://api.staging.superfield.ai/api/auth/me \
     -H "Cookie: superfield_auth=<old-token>"
   # Expected: HTTP 401
   ```

### Verification steps

- [ ] A token issued before the mass invalidation returns `401` for `/api/auth/me`
- [ ] A newly issued token (post-invalidation login) is accepted
- [ ] `SELECT COUNT(*) FROM revoked_tokens` shows the expected number of revoked JTIs
- [ ] All API server replicas reject the old token (verify against each pod)
- [ ] Response time for `/api/auth/me` remains within SLA (< 200 ms p99) — revocation store is performant

### Post-incident review checklist

- [ ] Confirm no session was accepted after the invalidation timestamp
- [ ] Determine root cause and scope of the original incident
- [ ] Validate the revocation store did not grow unbounded; run `cleanupExpiredRevocations()`
- [ ] File security finding and update the incident timeline
- [ ] Brief the team on lessons learned within 48 hours

---

## General escalation path

1. **On-call engineer** — execute the relevant scenario above
2. **Security lead** — notified for any scenario within 15 minutes of detection
3. **Engineering lead** — notified if customer data may have been accessed
4. **Legal / DPO** — notified if personal data was confirmed accessed (GDPR 72-hour clock starts)

## Related documents

- `docs/implementation-plan-v1.md` — Phase 1 security foundation
- `calypso-blueprint/rules/blueprints/auth.yaml` — AUTH-C-030, AUTH-D-009, AUTH-P-003
- Issue #92 — SOC 2 evidence packaging (Phase 8, wraps this runbook)

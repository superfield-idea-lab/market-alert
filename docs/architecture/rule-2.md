# Rule 2: auth — Authentication & Authorization

## Summary of the blueprint rule

The AUTH blueprint (version 1, depends on DATA) treats authentication as owned
infrastructure, not a rented service. Its central commitment: passkey-based
authentication (FIDO2 WebAuthn) is the sole primary credential mechanism — no
passwords, no magic links, ever. Four credential domains must remain permanently
distinct:

1. **End-user session credentials** — prove human identity; issued after passkey
   assertion; stored as HTTP-only, Secure, SameSite=Strict cookies.
2. **Worker / service credentials** — prove which daemon is calling; long-lived
   service accounts with a separate lifecycle.
3. **Delegated authority tokens** — prove who authorized a task-scoped action; scoped
   to the specific resource and operation; maximum 24-hour TTL.
4. **Sandbox / twin credentials** — prove sandbox-only context; cannot be exchanged
   for production write authority; revoked when the twin expires.

Key principles governing all four domains:

- **AUTH-P-001** (passkey-first-password-never): FIDO2 WebAuthn only; the private key
  never leaves the user's device.
- **AUTH-P-002** (tokens-opaque-to-browsers): session tokens in HTTP-only cookies;
  never in localStorage, response bodies, or URL parameters.
- **AUTH-P-003** (agent-credentials-scoped-and-short-lived): every agent token carries
  explicit scope claims and expires within 24 hours.
- **AUTH-P-004** (credential-domains-stay-separate): the four domains never collapse
  into one another.
- **AUTH-P-005** (auth-policy-enforced-through-deterministic-gates): policy is
  machine-checkable, not prose.
- **AUTH-P-006** (authority-and-execution-are-separate-facts): the authorizing principal
  and the executing agent are recorded separately on every consequential action.
- **AUTH-P-007** (no-single-actor-authorizes-privileged-operations): operations touching
  root key material, bulk exports, or auth infrastructure require M-of-N (≥ 2-of-3)
  approval via Shamir's Secret Sharing.
- **AUTH-P-008** (authentication-is-self-hosted): the critical login path runs on
  team-owned infrastructure; external providers may participate in federated flows but
  are never the sole path.
- **AUTH-P-009** (algorithm-pinned-not-negotiated): token verification accepts exactly
  one signing algorithm, configured at deployment time; the `alg` header field is
  ignored during verification.

Ten threat categories are explicitly mitigated: phishing/credential stuffing
(AUTH-T-001, AUTH-T-006), algorithm confusion forgery (AUTH-T-002), compromised admin
(AUTH-T-003), rogue agent exceeding scope (AUTH-T-004), token replay (AUTH-T-005),
single-insider privileged operation (AUTH-T-007), external provider outage (AUTH-T-008),
XSS session hijacking (AUTH-T-009), and agent credential log leaks (AUTH-T-010).

The chosen architecture for this platform is **AUTH-A-003: Agent-aware Auth Gateway** —
the only architecture designed for platforms where AI agents are first-class
participants. An Auth Gateway routes by credential type: human users go through the
passkey flow; agents go through the agent registry and scope validation. Both paths
produce tokens in the same format so the Resource Server (Auth Middleware) applies
uniform validation.

---

## TypeScript implementation specifics

The TypeScript implementation rules (IMPL-AUTH-001 through IMPL-AUTH-036) translate
the blueprint principles into concrete package structure, dependency decisions, and
interface shapes.

### Package structure

Auth code is split across three packages (IMPL-AUTH-021):

- `packages/auth/` — passkey logic, JWT sign/verify, agent-auth, middleware
- `apps/server/routes/auth.ts` — HTTP endpoints (registration, assertion, refresh,
  logout, agent issuance)
- `packages/core/types/auth.ts` and `user.ts` — shared TypeScript interfaces

Server-side auth primitives must never resolve in browser bundles (IMPL-AUTH-032):
even type-only imports from `packages/auth/` in browser code are prohibited.

### Authentication

- Passkey registration and assertion via `@simplewebauthn/server` (IMPL-AUTH-025) — the
  only external auth dependency. Full FIDO2 conformance, no native deps, actively
  maintained; justifies the buy decision over rolling a raw WebAuthn parser.
- Server stores only the public key and credential ID; no private key material,
  no password hash anywhere (IMPL-AUTH-022).
- Challenge/response flow: server generates random challenge → client signs with
  passkey → server verifies against stored public key (IMPL-AUTH-003).
- Key recovery uses a BIP-39 mnemonic (`@scure/bip39`, IMPL-AUTH-027) to encrypt a
  server-held recovery shard (AES-256-GCM via HKDF). Recovery requires the mnemonic
  plus a second factor: backup-code (Argon2id hash) or hardware-key (credential ID
  lookup). The flow re-enrolls a new passkey rather than restoring the old one
  (IMPL-AUTH-004, IMPL-AUTH-024).

### Token management

- **Signing**: ES256 (ECDSA P-256) via Web Crypto `crypto.subtle.sign /
crypto.subtle.verify` — DIY ~50 lines, zero JWT library dependency (IMPL-AUTH-005,
  IMPL-AUTH-026).
- **Algorithm pinning**: `alg` header is verified to equal `ES256` before any further
  validation; any other value is immediately rejected (IMPL-AUTH-006). Never use HS256
  (IMPL-AUTH-033).
- **Cookie delivery**: HTTP-only, Secure, SameSite=Strict; never in response body or
  URL (IMPL-AUTH-007).
- **Expiry**: default 1-hour TTL with rotation on refresh — each refresh produces a
  new token and immediately invalidates the old (IMPL-AUTH-008).
- **Revocation**: every token carries a `jti` claim; revocation table in the app
  database (IMPL-AUTH-009), queried on every authenticated request. In-memory cache
  permitted with ≤ 60-second TTL for standard revocations; security-critical
  revocations (account compromise, passkey change) bypass the cache entirely
  (IMPL-AUTH-010, IMPL-AUTH-011). Revocation entries are cleaned up by a scheduled
  job after the token's own `exp` passes (IMPL-AUTH-012). Never use in-memory-only
  revocation across processes (IMPL-AUTH-034).

### Unified token payload

`TokenPayload` interface (IMPL-AUTH-023):

```typescript
interface TokenPayload {
  sub: string; // userId or agentId
  jti: string; // unique token ID for revocation
  scopes: string[]; // e.g. ['analytics:read', 'schema:read']
  exp: number;
  iat: number;
  kind: 'user' | 'agent';
}
```

### Agent authentication

- Dedicated issuance endpoint — not the user login flow (IMPL-AUTH-015).
- Tokens carry explicit `scopes` claims (e.g., `['edgar:read', 'alerts:write']`);
  maximum TTL 24 hours; agents must re-authenticate daily (IMPL-AUTH-013, IMPL-AUTH-014).
- Agents receive KMS-scoped keys that can only decrypt data within their authorized
  scope (IMPL-AUTH-016).
- `requireScope` middleware at route registration — handlers never contain scope logic;
  a route without `requireScope` is a misconfiguration, not a valid open route;
  intentionally public routes use an explicit `public()` decorator (IMPL-AUTH-019,
  IMPL-AUTH-020).

### Rate limiting and lockout

- IP-based rate limiting on login and register endpoints (default 10 req/min per IP
  in dev; production values require deliberate review) (IMPL-AUTH-018).
- Per-username rate limiting applied in addition to per-IP to mitigate shared-NAT
  blind spots (IMPL-AUTH-035).
- Progressive delay (exponential backoff) rather than hard cutoff (IMPL-AUTH-036).
- DIY token bucket ~30 lines; no rate-limit library dependency (IMPL-AUTH-029).

### Auth data storage

All auth data lives in the application graph model as distinct entity types with their
own schemas and sensitivity settings (IMPL-AUTH-001):

- `user` entity
- `passkey_credential` entity (stores public key + credential ID only)
- `agent` entity (stores declared scopes, registration metadata)
- `recovery_shard` entity (stores encrypted shard; server cannot decrypt it)

---

## Application to market-alert PRD/plan

### PRD §3: User Roles

The PRD defines two roles — **Trader** and **Admin** — with distinct capability
boundaries:

- **Trader**: views and acknowledges alerts, accesses enriched event details, proposes
  and tracks trades. Trader-role tokens carry scopes such as `alerts:read`,
  `alerts:acknowledge`, `trades:write`, `trades:read`.
- **Admin**: manages data source configuration, overrides/suppresses alerts, views
  system health and audit trails, performs bulk exports. Admin-role tokens carry
  additional scopes: `sources:write`, `alerts:suppress`, `audit:read`, `exports:write`.

Both roles authenticate exclusively via passkey per AUTH-P-001. There is no Admin
"super-token" — Admin authority is scope-based, not credential-class-based.

Admin privileged operations (signing key rotation, bulk data export, auth config
changes) require M-of-N operator approval per AUTH-P-007 / AUTH-D-006. The minimum
acceptable configuration for this platform is 2-of-3; recommended 3-of-5 as the
operator pool grows.

### PRD §4: User Stories

- "As a Trader, I want to receive fresh alerts..." — passkey session authenticates the
  WebSocket upgrade; session cookie validated on the upgrade request; trader's watchlist
  scope enforced at RLS level, not just application level.
- "As a Trader, I want to see enriched event details..." — `GET /api/alerts/:id`
  requires `alerts:read` scope; auth middleware validates token + scope before handler
  executes; RLS policy further restricts to the trader's watchlist.
- "As an Admin, I want to configure and manage upstream data sources..." —
  `PATCH /api/sources/:id` requires `sources:write` scope; this scope is Admin-only
  and not issuable to Trader tokens.
- "As an Admin, I want to override or suppress false-positive alerts..." —
  `POST /api/alerts/:id/suppress` requires `alerts:suppress`; suppression action
  produces a dual-attribution audit entry recording both the Admin identity and the
  system actor that wrote the suppression record (AUTH-P-006, AUTH-D-004).

### Plan phases touching identity, RBAC, sessions, and audit

**Phase 0 — Scaffolding**: no auth yet, but auth endpoint route skeletons must be
registered with `requireScope` or `public()` from day one (IMPL-AUTH-020). The
twelve-check CI gate pre-registers auth-related checklist items.

**Phase 1 — Security foundation** (primary auth phase):

- Scout issue: end-to-end vertical slice passkey login → authenticated API call → RLS
  read → audit event written before the read commits. This proves the full
  identity → session → RLS-context → audit-first chain.
- Passkey registration + login (FIDO2 WebAuthn only; no password, no magic link).
- HTTP-only SameSite=Strict cookie delivery; token refresh rotation; progressive
  lockout; generic error messages.
- Passkey key recovery flow (BIP-39 mnemonic + second factor; recovery events notify
  all enrolled devices; AUTH-C-016/017).
- JWT/session hardening: ES256 algorithm pinned at deploy, JTI revocation table,
  CSRF double-submit on all cookie-authenticated mutations.
- Auth incident response runbook for four scenarios: signing key compromise, agent
  credential compromise, admin account compromise, mass session invalidation
  (AUTH-C-030); must be executed against staging before any market data lands.
- mTLS service mesh (Linkerd) — all pod-to-pod traffic mutually authenticated; worker
  → API and API → Postgres use short-lived workload identities.

**Phase 2 — EDGAR ingestion worker**: EDGAR ingestion worker receives a dedicated
agent token scoped to `edgar:read` and `corporate-actions:write`; maximum TTL 24 hours;
worker re-authenticates daily. Worker calls `POST /internal/ingestion/corporate-action`
with the delegated token — the internal endpoint validates scope before processing.
Worker egress is restricted to `www.sec.gov`, `efts.sec.gov`, and the API server only.

**Phase 3 — Alert enrichment pipeline**: enrichment worker token scoped to
`corporate-actions:read` and `alerts:write`. Dual attribution on the `Alert` entity
created by enrichment: authorizing principal is the Admin who enabled the ingestion
source; executing agent is the enrichment worker identity (AUTH-P-006, AUTH-D-004).
Digital twin sandbox in enrichment uses sandbox-only credentials (AUTH-D-005,
AUTH-C-013) — sandbox tokens cannot target production write endpoints.

**Phase 4 — Real-time alert delivery & trader UI**: WebSocket session validated via the
same HTTP-only cookie/JWT on the upgrade request. Trader's watchlist-filtered alert
channel enforced at the RLS layer, not just application logic. Outbound webhook channel
uses a per-trader HMAC secret stored encrypted in `mkt_app` — the webhook adapter holds
a KMS-scoped key to decrypt the per-trader secret at dispatch time.

**Phase 5 — Admin panel & source configuration**: Admin endpoints all require
`sources:write` or `audit:read` scope enforced by `requireScope` middleware. Audit trail
export (`exports:write`) is itself an audit event. Bulk alert export requires a
privileged-operation approval flow (M-of-N) before the export bundle is assembled.

**Phase 6 — Trade lifecycle tracking**: trade entities carry `trader_id`; RLS policy
restricts each trader to their own trades. Admin trade oversight uses an aggregate
view from `mkt_analytics` (not `mkt_app` direct reads — DATA-X-003 avoidance).
Each trade state transition is a dual-attribution business journal entry.

**Phase 7 — Event streaming & replay**: replay API scoped to `replay:read`; Admin-only
for export. Point-in-time state queries operate against the immutable business journal
— the journal itself is the audit substrate. Session pseudonyms in `mkt_analytics`
rotate per session via HMAC-SHA256 to prevent cross-session re-identification without
the dictionary key.

---

## Recommended technologies and vendors

### Identity provider

**Self-hosted passkey auth — no external identity provider (AUTH-P-008, IMPL-AUTH-028,
IMPL-AUTH-031).**

Justification: the blueprint explicitly prohibits depending on an external auth SaaS
(Auth0, Clerk, etc.) as the sole login path. The standard passkey + JWT flow is ~300
lines with Web Crypto and `@simplewebauthn/server`. For a hedge fund trading platform,
provider outage equaling login outage is unacceptable (AUTH-T-008). An external
provider's token format change would break sessions. Self-hosting eliminates per-user
SaaS cost, external debugging dashboards, and vendor lock-in on the most critical path.

### Session strategy

**HTTP-only, Secure, SameSite=Strict cookies with JWT (ES256) and server-side JTI
revocation table (IMPL-AUTH-007, IMPL-AUTH-008, IMPL-AUTH-009).**

Justification: HTTP-only cookies eliminate XSS-based token exfiltration categorically
(AUTH-T-009). Short-lived JWTs (1-hour default, rotate on refresh) limit replay windows.
The JTI revocation table in PostgreSQL (the `mkt_app` pool) provides immediate
invalidation on passkey change or session compromise, with a ≤ 60-second in-memory
cache for logout-class revocations. A Redis cache is explicitly rejected — it would
introduce a separate data store for a concern that the existing PostgreSQL pool handles
without additional infrastructure.

### RBAC model

**Scope-based RBAC enforced at the middleware layer via `requireScope`, with RLS
enforced at the PostgreSQL layer (IMPL-AUTH-019, IMPL-AUTH-020).**

Justification: the `scopes: string[]` claim on the unified `TokenPayload` carries the
authority model in the token itself without a separate permission service call on every
request. The `requireScope` middleware at route registration makes missing-scope a
build-time misconfiguration (detectable in CI) rather than a runtime gap. PostgreSQL
RLS provides a second enforcement layer that cannot be bypassed by application bugs —
the database itself blocks cross-trader and cross-admin reads. This two-layer model
(middleware scope + RLS) satisfies AUTH-P-005 (deterministic gates) without a separate
RBAC microservice.

### Secret store

**AWS KMS with HSM-backed keys, partitioned by sensitivity class.**

Justification: the plan mandates HSM-backed KMS in staging from Phase 1. KMS provides
automated key rotation (≤ 90-day policy), envelope encryption for field-level
AES-256-GCM, and audit logging of every key usage event via CloudTrail. KMS-scoped
agent keys (IMPL-AUTH-016) naturally map to KMS key policies that restrict decryption
to the specific IAM role held by each agent's service account. For the M-of-N
privileged operation flow, KMS provides a hardware root of trust for shard assembly.
Alternatives (HashiCorp Vault, GCP Cloud KMS) are equivalent in capability; AWS KMS is
chosen for operational simplicity assuming the platform runs on AWS.

### MFA story

**Passkey IS the MFA (FIDO2 WebAuthn with biometric or hardware key PIN) — no separate
TOTP/SMS second factor for standard login.**

Justification: a passkey authenticator (device biometric or hardware key) provides
possession ("this registered device") and inherence ("biometric") in a single gesture.
Adding TOTP on top is additive complexity for no security gain when the passkey already
eliminates phishing and credential stuffing at the protocol level (AUTH-P-001). For key
recovery only (the high-risk path where the device is lost), a second factor is required:
a backup code (Argon2id-hashed, printed at enrollment) or a hardware key (YubiKey
credential ID). This satisfies the second-factor requirement on the one flow that
genuinely needs it without adding TOTP infrastructure to the standard login path.

---

## Gaps and conflicts

1. **PRD §9: "minimal audit logging for MVP"** directly conflicts with AUTH-C-015
   (authentication events written to audit log), AUTH-C-028 (immutable auth audit log),
   and AUTH-C-029 (audit log exported to append-only cold storage). The plan resolves
   this by treating comprehensive audit as a Phase 1 gate, overriding the PRD intent.
   The architecture must never implement "audit-lite" auth logging at any phase.

2. **PRD specifies no authentication mechanism**. The plan correctly adds passkey-only
   from Phase 1. Any implementation that introduces a password fallback, magic link,
   or social OAuth as the sole login path violates AUTH-X-001 and AUTH-X-004
   categorically.

3. **Enrichment digital twin sandbox (Phase 3)** requires sandbox-only credentials
   (AUTH-D-005, AUTH-C-013). The plan references this but does not specify the
   credential issuance flow for sandbox tokens. This must be designed in Phase 3 — the
   sandbox token issuer needs its own endpoint and a scope validation step that
   prevents sandbox tokens from targeting production write endpoints.

4. **M-of-N privileged operations** (AUTH-P-007, AUTH-D-006) are required for root key
   material operations, bulk data exports (Phase 5, Phase 7), and auth config changes.
   The plan does not enumerate which Phase 5/7 export paths trigger the M-of-N gate.
   This must be made explicit before Phase 5 exits — each export type needs a documented
   decision: does it require M-of-N approval or is it gated by `audit:read` scope alone?

5. **Agent re-registration flow** (AUTH-C-022) — revoking and re-issuing agent
   credentials with new scopes — is not described in the plan. As new worker types land
   in Phases 2–4, the Agent Registry (AUTH-A-003) must have a documented
   re-registration path that triggers immediate token revocation for the affected agent.

6. **Outbound webhook HMAC secrets** (Phase 4) are per-trader, encrypted in `mkt_app`.
   The encryption scheme must use a KMS-scoped key distinct from the field-encryption
   key for alert content — per AUTH-P-004 (credential domains stay separate). This
   separation is implied but not stated explicitly in the plan.

7. **mTLS workload identity lifecycle** — the plan specifies Linkerd for the service
   mesh but does not specify how short-lived workload identities are issued and rotated.
   Linkerd's automatic mTLS uses SPIFFE SVIDs with a default 24-hour validity. The
   rotation interval must be ≤ 24 hours and the rotation mechanism must be verified in
   Phase 1 before market data lands.

---

## Open questions

1. **CSRF strategy for cross-subdomain deployments**: the plan specifies CSRF
   double-submit on all cookie-authenticated mutations (Phase 1). If the API server and
   the web frontend are on different subdomains (e.g., `api.market-alert.internal` vs.
   `app.market-alert.internal`), SameSite=Strict will block cookie transmission on
   cross-subdomain requests, and the double-submit token delivery mechanism needs to
   specify which origin sets the cookie. Should the architecture use a single-origin
   deployment (frontend served by the API server) or a same-origin proxy to preserve
   SameSite=Strict?

2. **Admin M-of-N shard holder pool size**: AUTH-D-006 recommends 3-of-5; minimum
   acceptable is 2-of-3. For an early-stage hedge fund platform, how many distinct human
   operators (shard holders) are realistically available? If the answer is two, the
   minimum 2-of-3 applies, which means any single shard holder being unavailable blocks
   all privileged operations. This is a people process question that must be answered
   before Phase 5 designs the export approval flow.

3. **Agent registry operator role**: AUTH-D-003 states that agent registration is a
   human-operator action requiring `agent-registry:write` scope. In the market-alert
   context, is this scope Admin-only, or is there a separate Operator role with narrower
   authority than Admin (e.g., can register agents but cannot suppress alerts or view
   audit trails)? Clarifying this determines whether Admin and Operator collapse into one
   role or split.

4. **Federated identity for enterprise clients**: AUTH-A-002 describes a federated path
   (SAML/OIDC) with self-hosted passkey fallback. The PRD does not mention enterprise
   tenants. If the platform is ever offered to multiple hedge fund clients sharing an
   instance, the Token Gateway normalization layer becomes necessary. Is multi-tenancy
   in scope for v2, and if so, should the Token Gateway be scaffolded (but gated) in
   Phase 1 to avoid a rework?

5. **Penetration test timing** (AUTH-C-021): the blueprint requires a structured
   security review on the authentication surface. Which phase triggers this gate —
   Phase 1 exit (auth surface exists) or Phase 4 exit (full trader session + WebSocket
   path exists)? Deferring until Phase 4 means market data lands (Phase 2) before the
   pentest, which is a compliance risk given the PRD §9 regulatory constraint (SEC).

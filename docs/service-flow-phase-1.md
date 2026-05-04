# Service Flow Map — Phase 1: Security Foundation

<!-- Phase: 1 — Security Foundation -->
<!-- Canonical docs: docs/plan.md § Phase 1 -->

## Overview

Phase 1 establishes the data layer, authentication, and audit foundations that all
subsequent phases build on. No market or user data can be stored until this phase is
merged.

---

## Authentication flow (passkey login)

```
Browser                 apps/server (auth/)              Postgres (mkt_app)
  |                            |                                |
  |-- POST /auth/register ---> |                                |
  |   (passkey challenge)      |-- INSERT credential ---------> |
  |                            |   (public key, user_id)        |
  |<-- 200 challenge response -|                                |
  |                            |                                |
  |-- POST /auth/verify -----> |                                |
  |   (authenticator response) |-- SELECT credential ---------> |
  |                            |<-- credential row -------------|
  |                            |                                |
  |                            |-- INSERT audit_event --------> | (mkt_audit)
  |                            |   BEFORE: auth read            |
  |<-- Set-Cookie session -----|                                |
```

Key invariants:

- Passkey-only. No password, no magic link (`AUTH-D-001`, `AUTH-X-001`).
- Audit write precedes any session establishment (`DATA-C-026`).
- Failed audit write denies login.
- SameSite=Strict, HTTP-only, Secure cookies.

---

## Four-pool Postgres architecture

```
mkt_app         mkt_audit       mkt_analytics   mkt_dictionary
   |                |                 |                |
   | operational    | append-only     | read-heavy     | trader identity
   | data           | hash-chained    | aggregates     | tokens
   |                | own role        |                | own role, own KMS
   |                | own KMS key     |                |
   |                |                 |                |
   +- mkt_app_role  +- mkt_audit_role +- mkt_ro_role   +- mkt_dict_role
      (rw app data)   (write-only)      (read-only)      (dict data)
```

No operational role can read the audit pool. Analytics pool starts empty;
populated in Phase 7.

---

## Field encryption flow (sensitive writes)

```
apps/server                     KMS                    Postgres (mkt_app)
    |                             |                          |
    |-- encrypt(plaintext, key) ->|                          |
    |<-- ciphertext + iv ---------|                          |
    |                             |                          |
    |-- INSERT entity ------------|------------------------> |
    |   (ciphertext stored)                                  |
```

- AES-256-GCM for all sensitive fields (`DATA-C-023`).
- KMS-managed keys partitioned by sensitivity class.
- Key rotation ≤ 90 days.

---

## Audit-before-read invariant

```
apps/server                         Postgres (mkt_audit)    Postgres (mkt_app)
    |                                       |                       |
    |-- BEGIN TRANSACTION ----------------> |                       |
    |-- INSERT audit_event (read intent) -> |                       |
    |   [if INSERT fails → ROLLBACK, deny read]                     |
    |-- SELECT sensitive_entity -----------------------> |          |
    |<-- entity row ----------------------------------------------- |
    |-- COMMIT ----------------------------------------> |          |
```

---

## RLS enforcement

```
SQL session                         Postgres (mkt_app)
    |                                      |
    |-- SET LOCAL role = trader_X -------> |
    |-- SELECT FROM alert_notes ---------->|
    |                                      |-- RLS policy: user_id = trader_X
    |                                      |   (other traders' notes are invisible)
    |<-- own rows only --------------------|
```

---

## Exit criteria

- An Admin session cannot read a Trader's private alert note even with a direct query.
- Audit query against any sensitive read returns a matching event.
- Key rotation invokable end-to-end against HSM-backed staging KMS.
- Auth incident runbook executed for all four scenarios (signing key compromise, agent
  credential compromise, admin account compromise, mass session invalidation).

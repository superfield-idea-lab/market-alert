# Database Architecture

## Overview

The application uses four structurally isolated Postgres databases. Each database
has its own connection pool, its own least-privilege role, and its own encryption
key domain. A compromise of one pool cannot expose data in any other.

This satisfies `DATA-D-006`: structural separation of the analytics tier from the
transactional tier, and structural isolation of the identity dictionary from all
other tiers.

## Databases and Roles

| Database        | Role                 | Privileges                                                       | Key Domain                          |
| --------------- | -------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| `kb_app`        | `app_rw`             | SELECT, INSERT, UPDATE, DELETE on all                            | `auth-key`, `crm-key`, `corpus-key` |
| `kb_audit`      | `audit_w`            | INSERT, SELECT on `audit_log`; UPDATE(`status`) only             | `audit-key`                         |
| `kb_analytics`  | `analytics_w`        | INSERT, SELECT on analytics tables                               | (none — Phase 7)                    |
| `kb_dictionary` | `dict_rw`            | SELECT, INSERT, UPDATE, DELETE on `identity_tokens`              | `identity-key`                      |
| `kb_app`        | `compliance_officer` | SELECT on compliance tables; RESTRICTIVE RLS on customer content | n/a                                 |

## Connection Pools

`packages/db/index.ts` exports four pools:

- `sql` — bound to `kb_app` as `app_rw` (max 20 connections)
- `auditSql` — bound to `kb_audit` as `audit_w` (max 5 connections)
- `analyticsSql` — bound to `kb_analytics` as `analytics_w` (max 5 connections)
- `dictionarySql` — bound to `kb_dictionary` as `dict_rw` (max 5 connections)

The dictionary pool (`dictionarySql`) is reserved for the `IdentityDictionary`
service. All other modules must not import it directly.

## Cross-Pool Isolation

Cross-pool access is denied at the database layer — not just via RLS policies:

- `app_rw` has no `CONNECT` privilege on `kb_audit`, `kb_analytics`, or `kb_dictionary`.
- `dict_rw` has no `CONNECT` privilege on `kb_app`, `kb_audit`, or `kb_analytics`.
- `audit_w` has no `CONNECT` privilege on `kb_app`, `kb_analytics`, or `kb_dictionary`.
- `analytics_w` has no `CONNECT` privilege on `kb_app`, `kb_audit`, or `kb_dictionary`.

Integration tests in `packages/db/pool-isolation.test.ts` assert these restrictions
at the database layer on every CI run.

## Encryption Key Domains

Each pool's encrypted columns reference a distinct KMS key domain. The domains are
disjoint — a key from one domain cannot decrypt ciphertext from another.

```typescript
export const KEY_DOMAINS = {
  app: ['auth-key', 'crm-key', 'corpus-key'],
  audit: ['audit-key'],
  analytics: [],
  dictionary: ['identity-key'],
};
```

Backing KMS key material is provisioned by the Phase 2 KMS abstraction follow-on.

## Schemas

### `kb_app` (`schema.sql`)

Transactional data: entities, relations, entity_types, users, tasks, task_queue,
feature_flags, api_keys, worker_credentials, auth_lockout.

### `kb_audit` (`audit-schema.sql`)

Append-optimised audit log: `audit_log` table with INSERT + SELECT grants for
`audit_w`. UPDATE is restricted to the `status` column only. No DELETE or TRUNCATE.

### `kb_analytics` (`analytics_events`, `audit_replica`)

Analytics tier (empty after init; populated in Phase 7). `analytics_w` holds
INSERT + SELECT only. No UPDATE, DELETE, or TRUNCATE.

### `kb_dictionary` (`dictionary-schema.sql`)

Identity dictionary: `identity_tokens` maps anonymisation tokens to real-world
identities (name, email, org). Sensitive columns are encrypted using the
`identity-key` domain before INSERT.

## Genesis Initialisation

`packages/db/init-remote.ts` provisions all four databases and roles in a single
idempotent run. It is executed by the `db-init` container at deploy time.

Environment variables required:

| Variable                      | Purpose                           |
| ----------------------------- | --------------------------------- |
| `ADMIN_DATABASE_URL`          | Superuser connection for DDL      |
| `APP_RW_PASSWORD`             | Password for `app_rw`             |
| `AUDIT_W_PASSWORD`            | Password for `audit_w`            |
| `ANALYTICS_W_PASSWORD`        | Password for `analytics_w`        |
| `DICT_RW_PASSWORD`            | Password for `dict_rw`            |
| `AGENT_CODING_PASSWORD`       | Password for `agent_coding`       |
| `AGENT_ANALYSIS_PASSWORD`     | Password for `agent_analysis`     |
| `AGENT_CODE_CLEANUP_PASSWORD` | Password for `agent_code_cleanup` |

Optional overrides for database names: `APP_DB`, `AUDIT_DB`, `ANALYTICS_DB`,
`DICTIONARY_DB`.

## Worker Roles

A shared `agent_worker` base role (no LOGIN) acts as a privilege group. Per-type
agent roles (`agent_coding`, `agent_analysis`, `agent_code_cleanup`) inherit from
it and hold SELECT on their per-type filtered views in `kb_app` only.

Worker roles have no access to `kb_audit`, `kb_analytics`, or `kb_dictionary`.

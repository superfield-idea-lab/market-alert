# Architecture Doc Remediation Plan

Target file: `docs/architecture.md`

Issues are ordered by severity. Items 1–3 require structural decisions before
writing; items 4–10 are editorial fixes.

---

## 1. Worker topology — rewrite Task Queue § to match `IMPL-TQ-TS-001`

**What is wrong:** The "Task queue" and "Workers" sections describe workers
holding `LISTEN/NOTIFY` connections and falling back to polling. `IMPL-TQ-TS-001`
prohibits this: workers never hold a database connection; they carry no
`DATABASE_URL`.

**What the correct model is:**

- `apps/server` holds one persistent PostgreSQL `LISTEN` connection per task
  type via a dedicated `postgres` client (separate from the main pool).
- An in-process SSE fan-out registry (`apps/server/src/task-queue/sse.ts`)
  maps `task_type → Set<ReadableStreamController>`.
- Workers open `EventSource` to `GET /api/v1/tasks/stream?token=<service_token>`
  (token in query param because `EventSource` does not support custom headers).
- On `task_available` or `heartbeat` events, workers call
  `POST /api/v1/tasks/claim`.
- A `setInterval` on the server emits `heartbeat` every
  `TASK_QUEUE_POLL_INTERVAL_MS` (default 5 000 ms) to guarantee discovery even
  when a `pg_notify` is missed (`IMPL-TQ-TS-003`).

**Changes to make:**

- Replace the "Push notification" row in the task queue section with the
  SSE fan-out description above.
- Add `GET /api/v1/tasks/stream` as a documented internal endpoint in the
  task queue section.
- Remove all language about workers holding `LISTEN` connections or falling
  back to direct polling.
- Update the "Worker credentials" paragraph in Auth to confirm workers carry
  only a scoped machine API token — no `DATABASE_URL`.
- Update the "Workers" section process model to note workers have no database
  connection; the SSE client is the only persistent connection they hold.

---

## 2. Database model — replace two-pool/two-role with three-database/three-role

**What is wrong:** The architecture doc uses `mkt_app` and `mkt_analytics`
pools with a single `mkt_app_user` role. `IMPL-DATA-001`–`IMPL-DATA-004` and
`DATA-C-001`/`DATA-C-002` require three schemas and three roles that never
cross boundaries.

**Required model:**

| Schema          | Role              | Permissions                         |
| --------------- | ----------------- | ----------------------------------- |
| `mkt_app`       | `mkt_app_rw`      | Read/write on transactional tables  |
| `mkt_analytics` | `mkt_analytics_w` | INSERT-only on analytics tables     |
| `mkt_audit`     | `mkt_audit_w`     | INSERT-only on audit/journal tables |

Each role gets its own connection pool. No role crosses schema boundaries.
The `mkt_audit_w` pool is the only path for writing to `journal_entries` and
the audit log — move `journal_entries` from `mkt_app` to the `mkt_audit`
schema.

**Changes to make:**

- Rename `mkt_app_user` → `mkt_app_rw` everywhere.
- Add `mkt_audit` schema and `mkt_audit_w` role to the "Database pools" table.
- Move `journal_entries` (replay ledger) from `mkt_app` schema to `mkt_audit`
  schema.
- Update the "Row-level security" paragraph to reference `mkt_app_rw`.
- Update the "Worker credentials" paragraph: workers call internal endpoints;
  `apps/server` uses `mkt_app_rw` for transactional writes and `mkt_audit_w`
  for journal writes.
- Add a note that `mkt_analytics` is Phase 7 and the `mkt_analytics_w` pool
  is provisioned but idle until that phase.

---

## 3. Schema model — document domain tables as intentional deviation from property graph

**What is wrong:** `IMPL-DATA-002` specifies a three-table property graph
(`entities`, `relations`, `entity_types`). The architecture doc describes
conventional domain tables without acknowledging the divergence.

**Decision required (pick one before editing):**

**Option A — Adopt property graph.** Replace the domain-table description with
the three-table graph model. Domain entities (Alert, CorporateAction, Trade)
become entity types; relationships (Alert→CorporateAction) become `relations`
rows. Auth entities (user, passkey_credential, agent, recovery_shard) become
entity types, satisfying `IMPL-AUTH-001`.

**Option B — Document deliberate deviation.** Keep domain tables. Add an
"Architecture decision log" entry explaining why the property graph was
rejected for this product (e.g., fixed regulatory schema, audit partitioning
requirements, RLS at the table level is simpler than at the JSONB property
level). This deviation must be explicit so a future agent does not rewrite the
schema to conform to the blueprint default.

**If Option B is chosen, also address `IMPL-AUTH-001`:** Auth entities
(`passkey_credentials`, `jti_revocations`, `machine_tokens`) should be listed
explicitly in the schema section so it is clear where auth data lives.

**Changes to make (Option B assumed unless directed otherwise):**

- Add an ADL row: "Schema model — domain tables vs. property graph — Rejected
  property graph; domain tables with explicit RLS and partition-pruning are
  simpler to audit and query for regulatory reporting."
- Add a schema inventory listing every top-level table and the schema it lives
  in (`mkt_app`, `mkt_analytics`, `mkt_audit`).
- List auth tables explicitly (`passkey_credentials`, `jti_revocations`,
  `machine_tokens`) under the Authentication section or Data layer section.

---

## 4. Directory layout — document `packages/db`, `apps/worker`, `apps/admin` as deliberate expansions

**What is wrong:** `IMPL-ARCH-009` canonical layout lists
`/packages/{ui,core,services,integrations}` and `/apps/{web,server}`.
The architecture doc silently adds `packages/db`, `apps/worker`, `apps/admin`.

**Changes to make:**

- Add a "Deliberate layout expansions" subsection under "Monorepo layout"
  containing:
  - `apps/worker` — separate deployable per `WORKER-D-001`; different scaling
    profile and network-egress policy from `apps/server`. Justified expansion
    of `ARCH-A-001`.
  - `apps/admin` — separate deployable for the Admin role (PRD §3); shares
    `packages/ui` with `apps/web` but has distinct auth scopes
    (`alerts:admin`, `sources:admin`).
  - `packages/db` — PostgreSQL schema DDL, migrations, and task-queue
    primitives. Kept separate from `packages/core` because it has deploy-time
    lifecycle (migration runner) distinct from pure business logic. **OR:**
    document the decision to fold it into `packages/core/db` if that path is
    chosen instead.

---

## 5. Remove Ajv v8; Zod is the single validation source

**What is wrong:** The doc says "Ajv v8 with JSON Schema derived from Zod
definitions." Maintaining two schema representations (Zod + generated JSON
Schema fed to Ajv) is redundant and adds a dependency without a Buy/DIY entry.
`IMPL-ARCH-022`/`IMPL-ARCH-023` require justification; `ARCH-P-003` treats
every dependency as a liability.

**Changes to make:**

- Replace the Ajv sentence with: "Zod schemas in `/packages/core` validate
  inbound API payloads at system boundaries. `z.parse()` is the runtime
  validator; `z.infer<>` is the static type. No secondary schema representation."
- If Ajv is retained (e.g., for JSON Schema compatibility with an external
  tool), add a `docs/dependencies.md` entry with the Buy/DIY rationale and
  reference it from the architecture doc.

---

## 6. Add Buy/DIY justification for TanStack Query v5

**What is wrong:** TanStack Query is a significant dependency added without a
`docs/dependencies.md` entry or inline rationale. `IMPL-ARCH-022`/`IMPL-ARCH-023`
require both conditions: (1) not feasible internally, (2) mature/minimal.

**Changes to make:**

- Add an ADL row or inline note: "Server data fetching — TanStack Query v5 —
  native fetch — TanStack Query chosen because stale-while-revalidate,
  background refetch, and the `state-matrix.json` loading/empty/error/success
  states require non-trivial cache management that would otherwise be rebuilt
  by hand. Passes Buy criteria: critical functionality not feasible at small
  size; TanStack Query is the most-maintained headless data-fetching library."
- Add a `docs/dependencies.md` entry (this file is a Phase 0 deliverable per
  `ARCH-C-005`).

---

## 7. Add SSE task-stream endpoint to Task Queue section

**What is wrong:** The SSE endpoint is the only mechanism workers use to
discover tasks (`IMPL-TQ-TS-004`), but it is absent from the architecture doc.

**Changes to make:**

- Add a "Task discovery" subsection inside "Task queue":
  - `GET /api/v1/tasks/stream?token=<service_token>` — SSE endpoint; token
    in query param (browser `EventSource` does not support custom headers;
    redacted from access logs).
  - Server emits `data: task_available\n\n` on `pg_notify` and
    `data: heartbeat\n\n` every `TASK_QUEUE_POLL_INTERVAL_MS`.
  - Workers reconnect automatically via `EventSource` built-in retry.

---

## 8. Add test directory paths

**What is wrong:** The "Testing" section names test categories but not their
canonical paths, which are required by `IMPL-TEST-004`–`IMPL-TEST-007`.

**Changes to make:**

- Add a directory table to the "Testing" section:

  | Suite       | Location             | Engine                                                  |
  | ----------- | -------------------- | ------------------------------------------------------- |
  | Unit        | `/tests/unit`        | Vitest, Bun runtime, no browser                         |
  | Integration | `/tests/integration` | Vitest, Bun runtime, real PostgreSQL via testcontainers |
  | Component   | `/tests/component`   | Vitest + Playwright (headless Chromium)                 |
  | E2E         | `/tests/e2e`         | Vitest + Playwright (headless Chromium)                 |

---

## 9. Add BIP-39 passkey recovery to Authentication section

**What is wrong:** `IMPL-AUTH-004` requires a BIP-39 mnemonic to encrypt a
recovery shard stored server-side; recovery requires the mnemonic plus a second
factor (backup code via Argon2id hash, or hardware key via credential ID
lookup). The architecture doc omits this entirely.

**Changes to make:**

- Add a "Credential recovery" paragraph under Authentication:
  "Key recovery uses a BIP-39 mnemonic to encrypt a recovery shard stored
  server-side (`mkt_app.recovery_shards`). Recovery requires the mnemonic plus
  a second factor: a backup code (Argon2id hash) or an enrolled hardware key
  (credential ID lookup). No password-reset email path exists."

---

## Editing order

1. Resolve the Option A/B schema decision (item 3) first — it affects the
   data layer, auth, and ADL sections.
2. Apply item 2 (three roles/three pools) — depends on schema decision.
3. Apply item 1 (worker SSE topology) — independent of schema decision.
4. Apply items 4–9 in any order.
5. Verify `docs/dependencies.md` exists and has entries for every package
   named in the architecture doc (`@simplewebauthn/server`, `fast-xml-parser`,
   `cheerio`, `TanStack Query`, `TanStack Table`, `imapflow`, `testcontainers`,
   `MSW v2`, `pino`, `Zod`, `Hono`, `postgres`). This file is a Phase 0
   deliverable (`ARCH-C-005`, `IMPL-ARCH-023`).

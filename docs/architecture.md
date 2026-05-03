# Architecture

## Overview

Market-alert is an event-driven arbitrage alert platform for hedge fund traders. It ingests
EDGAR corporate action filings via RSS, enriches and deduplicates them against the watchlist
universe, and delivers sub-second alerts to traders via WebSocket and outbound channels (email,
SMS, webhook).

The system is a TypeScript monorepo with four deployable applications backed by a shared
PostgreSQL 16 database. All asynchronous work flows through a Postgres-native durable task
queue. Workers carry no database credentials; they communicate exclusively through scoped
internal API endpoints.

---

## Monorepo layout

```
apps/
  server/        — Hono/Bun HTTP + WebSocket API server
  worker/        — Bun worker processes (ingestion, enrichment, delivery)
  web/           — React/Vite trader dashboard (SPA)
  admin/         — React/Vite admin panel (SPA)
packages/
  core/          — Shared TS types, entity models, state machines, algorithms
  ui/            — Shared design system (shadcn/ui, Tailwind tokens)
  db/            — Postgres schema, migrations, task-queue primitives
  services/      — Internal API clients (server-to-server)
  integrations/  — Third-party SDK wrappers (EDGAR, SMTP, SMS)
tests/
  fixtures/      — Committed JSON fixtures (EDGAR RSS, SEC filings, vendor responses)
docs/
  architecture/  — Per-blueprint research notes (source material for this document)
```

**Package manager:** pnpm (strict, content-addressed `node_modules`; workspace hoisting
disabled).

**Dependency budget rule (ARCH-P-003):** every new dependency requires a Buy/DIY decision
logged in `docs/dependencies.md`. That file is a Phase 0 deliverable.

**Deliberate layout expansions** (deviations from `IMPL-ARCH-009` canonical layout):

- `apps/worker` — separate deployable per `WORKER-D-001`; different scaling profile and
  network-egress policy from `apps/server`. Justified expansion of `ARCH-A-001`.
- `apps/admin` — separate deployable for the Admin role (PRD §3); shares `packages/ui`
  with `apps/web` but has distinct auth scopes (`alerts:admin`, `sources:admin`).
- `packages/db` — PostgreSQL schema DDL, migrations, and task-queue primitives. Kept
  separate from `packages/core` because it has a deploy-time lifecycle (migration runner)
  distinct from pure business logic.

---

## Runtime

| Context       | Runtime                  |
| ------------- | ------------------------ |
| `apps/server` | Bun ≥ 1.1                |
| `apps/worker` | Bun ≥ 1.1                |
| `apps/web`    | Browser (Vite build)     |
| `apps/admin`  | Browser (Vite build)     |
| Tests         | Bun (Vitest runs on Bun) |
| CI            | Bun ≥ 1.1                |

Bun is mandated by `IMPL-ARCH-002`. Native TypeScript execution eliminates the `tsx`/`tsc`
dev dependency; the built-in bundler handles production builds. `tsx` is not used.

---

## HTTP server

**Framework:** Hono on Bun (`apps/server`).

Hono is a thin, type-first router with first-class Bun support and minimal transitive
dependencies. Route handlers consume request/response types from `/packages/core` directly.

All API surfaces are REST. The sole non-REST exception is the Phase 4 WebSocket upgrade path,
which is the only sanctioned real-time transport and is justified by the PRD §9 sub-second
latency SLA.

**WebSocket transport:** Bun's native `Bun.serve` WebSocket upgrade (no `ws` library). The
LISTEN/NOTIFY → WebSocket push path must deliver within 1 second of an alert reaching
`Deduplicated` state. Sticky sessions via ALB target group are required for multi-replica
deployments until a pub/sub fan-out strategy is chosen (see Open questions §3).

---

## Frontend

**Apps:** `apps/web` (Trader dashboard) and `apps/admin` (Admin panel) — separate deployable
SPAs sharing `packages/ui`.

**Build:** Vite + `@vitejs/plugin-react` (IMPL-ARCH-003, IMPL-ARCH-010). Compiles to a pure
browser bundle. `apps/server` serves the static assets; no SSR layer.

**Framework:** React 18.x.

**State management:** React Context + `useReducer` (DIY). No Redux or Zustand. The alert feed
is a WebSocket hook updating a single `AlertFeedContext`.

**Server data fetching:** TanStack Query v5 — handles loading/empty/error/success states
required by UX `state-matrix.json` contracts; stale-while-revalidate for non-real-time views.

**Realtime:** Native browser `WebSocket` connecting to `apps/server` (`wss://`), authenticated
on the HTTP upgrade request via HTTP-only cookie. No third-party relay (no Pusher, Ably).

**UI components:** shadcn/ui — headless Radix UI primitives copy-owned in
`packages/ui/design-system/`, styled with Tailwind CSS 3.x tokens. Components live under
project control; no runtime dependency on an external library version.

**Forms:** DIY controlled React inputs (`useState`). No react-hook-form or Formik. Both the
watchlist management form and trade proposal form are simple enough not to warrant a library.

**Alert list / data table:** TanStack Table v8 (headless; rendering delegated to design system
components). Supports sort, client-side filter by event type / spread threshold / date range,
and column control.

**Styling:** Tailwind CSS 3.x, vanilla. Both `apps/web` and `apps/admin` draw from the same
token system defined in `packages/ui`.

---

## Data layer

**Database:** PostgreSQL 16.

**Query layer:** `postgres` npm package with tagged-template literal queries. No ORM. Queries
are typed against `/packages/core` entity types and are directly readable in query plans.
Connection pools are acquired at process startup and released on SIGTERM.

**Migrations:** Custom `migrator.ts` in `packages/db` implementing a three-layer model:
structural DDL, idempotent seed, and feature-gated data migrations. No external migration
framework.

**Time partitioning:** `alerts` and `corporate_actions` use monthly `RANGE` partitioning on
`created_at` / `announced_at`. Partition pruning keeps query plans bounded as event volume
grows.

**Replay storage:** A hash-chained `journal_entries` table in the `mkt_audit` schema. Each entry
stores a content hash of the previous entry, making history tamper-evident for audit and replay
(PRD §9 Replay constraint). Written exclusively via the `mkt_audit_w` pool.

**Object storage:** AWS S3 (MinIO in dev/test) with Object Lock (WORM mode) for raw SEC filing
archives. Filings are immutable; Object Lock prevents accidental deletion.

**Schema validation:** Zod schemas in `/packages/core` validate inbound API payloads at
system boundaries. `z.parse()` is the runtime validator; `z.infer<>` is the static type.
No secondary schema representation.

**Database pools:**

| Pool            | Role              | Permissions                                                                   |
| --------------- | ----------------- | ----------------------------------------------------------------------------- |
| `mkt_app`       | `mkt_app_rw`      | Read/write on transactional tables (alerts, trades, task queue)               |
| `mkt_analytics` | `mkt_analytics_w` | INSERT-only on analytics tables (Phase 7 — pool provisioned, idle until then) |
| `mkt_audit`     | `mkt_audit_w`     | INSERT-only on audit/journal tables (`journal_entries`, audit log)            |

No role crosses schema boundaries.

**Row-level security:** PostgreSQL RLS enforces trader-scoping on `alerts` and `trades`.
`apps/server` runs queries as the `mkt_app_rw` role with RLS active. Workers never hold
database credentials; they call internal endpoints instead.

**Schema inventory:**

| Schema          | Tables                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mkt_app`       | `alerts`, `corporate_actions`, `trades`, `raw_filings`, `etl_cursors`, `etl_quarantine`, `task_queue`, `passkey_credentials`, `jti_revocations`, `machine_tokens`, `recovery_shards`, `feature_flags` |
| `mkt_analytics` | Analytics projection tables (Phase 7)                                                                                                                                                                 |
| `mkt_audit`     | `journal_entries`, `audit_log`                                                                                                                                                                        |

---

## Authentication and authorization

**Identity:** Self-hosted passkey authentication via `@simplewebauthn/server`. No Auth SaaS.
Passkeys eliminate shared-secret credentials for the Trader and Admin roles (PRD §3).

**Sessions:** ES256 JWTs issued on successful WebAuthn assertion. Stored in HTTP-only,
`SameSite=Strict` cookies. A `jti_revocations` PostgreSQL table enables server-side revocation
(logout, force-expire on credential compromise).

**RBAC:** Scope-based authorization enforced by `requireScope` middleware in `apps/server`.
Scopes: `alerts:read`, `alerts:acknowledge`, `alerts:admin`, `sources:admin`,
`trades:propose`, `trades:execute`, `replay:read`. PostgreSQL RLS provides data-layer
enforcement in addition to middleware enforcement.

**Worker credentials:** Workers carry no `DATABASE_URL` and hold no database connection.
They authenticate with a scoped machine API token (AWS Secrets Manager, rotated weekly) and
call scoped `POST /internal/...` endpoints on `apps/server`. The internal surface is the
only path to database writes for worker processes. On the server side, transactional writes
use the `mkt_app_rw` pool; journal/audit writes use the `mkt_audit_w` pool.

**Credential recovery:** Key recovery uses a BIP-39 mnemonic to encrypt a recovery shard
stored server-side (`mkt_app.recovery_shards`). Recovery requires the mnemonic plus a
second factor: a backup code (Argon2id hash) or an enrolled hardware key (credential ID
lookup). No password-reset email path exists.

**Key management:** AWS KMS with HSM-backed keys, partitioned by sensitivity class (PII,
financial, audit). Passkey biometrics or a hardware key serve as MFA on the key-recovery path.

---

## Ingestion (ETL)

**v1 source:** EDGAR RSS/Atom feed polled by the ingestion worker. EDGAR RSS is the sole v1
ingestion source.

**RSS client:** `fast-xml-parser` + native `fetch`. Zero native dependencies.

**HTTP caching:** In-process `If-Modified-Since` / `ETag` cache. On 304 Not Modified the
worker short-circuits without creating tasks. On 200 it compares accession numbers against the
per-form-type watermark.

**Idempotency key:** `edgar_poll:<form_type>:<accession_number>`. The accession number is the
stable EDGAR identity (structurally equivalent to an IMAP UID). `ON CONFLICT DO NOTHING` on
`raw_filings` insert.

**SEC filing parsing:** `cheerio` for HTML filing text extraction. Structured terms extraction
in v1 uses deterministic regex. The Phase-v2 upgrade path uses Claude Sonnet
(`claude-sonnet-4-6`) via the Anthropic SDK with prompt caching enabled for repeated filing
structures.

**Watermark:** Per-form-type cursor stored in `mkt_app.etl_cursors`. The worker advances the
cursor only after a durable write (`land-before-advance` pattern). Out-of-order amended filings
(`8-K/A`) are handled by an overlap window that re-scans recent accession numbers.

**Error handling:** Task queue DLQ for failed enrichment tasks. `etl_quarantine` table for
malformed filings that cannot be parsed. The worker continues on partial extraction failure
rather than blocking the queue.

**Post-v1 IMAP:** Bloomberg, DealReporter, and other vendors named in PRD §1 deliver via email
feeds. When licensed, each vendor mailbox becomes an independent ETL partition using `imapflow`
as the IMAP client, with its own UID cursor and UIDVALIDITY epoch per the imap-etl blueprint.

---

## Task queue

**Implementation:** Postgres-native durable task queue in `/packages/db/task-queue.ts`.
No Redis. No external queue broker.

**Claim mechanism:** `SELECT ... FOR UPDATE SKIP LOCKED` — atomic, concurrent-safe claims.

**Push notification:** `apps/server` holds one persistent PostgreSQL `LISTEN` connection per
task type via a dedicated `postgres` client (separate from the main pool). An in-process SSE
fan-out registry (`apps/server/src/task-queue/sse.ts`) maps `task_type → Set<ReadableStreamController>`.
Workers open `EventSource` to `GET /api/v1/tasks/stream?token=<service_token>` (token in
query param because `EventSource` does not support custom headers; redacted from access logs).
On `task_available` or `heartbeat` events workers call `POST /api/v1/tasks/claim`. A
`setInterval` on the server emits `heartbeat` every `TASK_QUEUE_POLL_INTERVAL_MS` (default
5 000 ms) to guarantee discovery even when a `pg_notify` is missed (`IMPL-TQ-TS-003`).
Workers reconnect automatically via `EventSource` built-in retry.

**Task discovery endpoint:** `GET /api/v1/tasks/stream?token=<service_token>` — SSE stream;
server emits `data: task_available\n\n` on `pg_notify` and `data: heartbeat\n\n` every
`TASK_QUEUE_POLL_INTERVAL_MS`. Workers never hold a direct database connection.

**Task types:**

| Task type             | Delivery      | Priority | Idempotency key                     |
| --------------------- | ------------- | -------- | ----------------------------------- |
| `EDGAR_POLL`          | At-least-once | Normal   | `edgar_poll:<form>:<accession>`     |
| `ALERT_ENRICH`        | At-least-once | High     | `enrich:<alert_id>`                 |
| `ALERT_DEDUP`         | At-least-once | High     | `dedup:<alert_id>`                  |
| `ALERT_NOTIFY`        | At-least-once | Normal   | `notify:<alert_id>:<channel>`       |
| `CORP_ACTION_ADVANCE` | At-least-once | Low      | `ca_advance:<ca_id>:<target_state>` |
| `TRADE_SETTLE`        | At-least-once | Low      | `settle:<trade_id>`                 |

**Stale recovery:** Worker heartbeat via `updated_at`. Claims older than the per-type TTL are
re-queued by the stale-recovery cron. Each task type has an independent `claim_expires_at`
configuration (slow enrichment requires a longer TTL than fast settlement).

**Scheduled tasks:** Application-level in-process scheduler (not pg_cron). A `scheduler`
singleton in `apps/server` enqueues periodic tasks (EDGAR poll cadence, stale recovery,
retention sweep) on startup.

**Queue depth metric:** `pg_query_exporter` exposes
`task_queue_pending_total{job_type="..."}` as a Prometheus gauge.

**Autoscaling:** KEDA `prometheus` trigger drives Kubernetes HPA for worker Deployments. Scale
target is `ALERT_ENRICH` queue depth (not `EDGAR_POLL`, which is a singleton).

**DLQ replay:** Manual via admin panel (Phase 7). DLQ items are queryable and re-queueable
from `apps/admin`.

---

## Workers

Five worker classes, each a separate Kubernetes Deployment in `apps/worker`:

| Worker            | Task types                            | Concurrency                      |
| ----------------- | ------------------------------------- | -------------------------------- |
| Ingestion poller  | `EDGAR_POLL`                          | 1 pod (singleton)                |
| Enrichment worker | `ALERT_ENRICH`                        | `max_tasks` batch, `Promise.all` |
| Dedup worker      | `ALERT_DEDUP`                         | `max_tasks` batch, `Promise.all` |
| Delivery worker   | `ALERT_NOTIFY`                        | `max_tasks` batch, `Promise.all` |
| Lifecycle worker  | `CORP_ACTION_ADVANCE`, `TRADE_SETTLE` | 1 per type                       |

**Process model:** Single-threaded Bun event loop per pod. No worker threads at MVP scale. HPA
adds pod replicas when queue depth exceeds the KEDA threshold. Workers hold no database
connection; the `EventSource` SSE client to `GET /api/v1/tasks/stream` is the only persistent
connection they maintain.

**Graceful shutdown:** `process.on('SIGTERM')` stops claiming new tasks, drains in-flight
tasks up to a configurable timeout, then exits. No external shutdown library required (~30
lines in `apps/worker/src/runner.ts`).

**Sub-second SLA scope:** The 1-second SLA (PRD §9) applies to the `Deduplicated` →
WebSocket push segment. Outbound channels (email, SMS, webhook) are dispatched asynchronously
by the delivery worker and are not on the sub-second path. `ALERT_NOTIFY` failures are
non-blocking; the `Delivered` state is set on WebSocket push completion.

---

## Environment and configuration

**Validation:** Zod schemas at process startup. Missing or malformed env vars throw at startup,
not at request time.

**Secrets:** AWS Secrets Manager, surfaced into Kubernetes Secrets via External Secrets
Operator (ESO). Workers receive no database credentials — only a scoped machine API token.

**Non-secret config:** Kubernetes ConfigMaps. Differences between dev and production are
expressed through ConfigMap values and PostgreSQL feature-flag rows, never through code
branches.

**Dev environment:** k3d (lightweight Kubernetes in Docker). `init-host.sh` performs the
ten-step credential lifecycle: ephemeral admin credentials for cluster setup, long-lived
least-privilege Kubernetes Secrets for runtime.

**Frontend env vars:** Baked into release artifacts at Vite build time (`import.meta.env`).
Not runtime-injected.

---

## Deployment and infrastructure

**Cloud:** AWS us-east-1. Co-located with EDGAR's US hosting to minimize RTT on the critical
detection path.

**Compute:** EKS with managed node groups (not Fargate — node-level control required for KEDA
and Linkerd).

**Container image:** Bun distroless (`oven/bun:distroless`). No shell, no package manager in
runtime images.

**IaC:** Terraform (cluster, networking, IAM, S3, KMS) + Helm (application workloads, KEDA,
Linkerd, ESO).

**Networking:** AWS ALB + ACM for TLS termination at ingress. Linkerd service mesh for mTLS
between pods.

**Secrets in cluster:** External Secrets Operator syncs AWS Secrets Manager → Kubernetes
Secrets. Secrets are never written to files, logs, or environment variable dumps.

**CI/CD:** GitHub Actions + Amazon ECR. Pipeline: build → test → push image → Helm upgrade.
Rollback is a `helm rollback`.

**Observability:**

| Signal  | Vendor                                                   |
| ------- | -------------------------------------------------------- |
| Logs    | Grafana Cloud (Loki) — pino JSON logs via Promtail       |
| Metrics | Grafana Cloud (Mimir) — Prometheus scrape + KEDA metrics |
| Traces  | Grafana Cloud (Tempo) — OpenTelemetry OTLP export        |
| Errors  | Sentry (exception capture with `trace_id` correlation)   |
| On-call | PagerDuty (Grafana alerting integration)                 |

---

## Testing

**Runner:** Vitest for all suites — unit, integration, component, E2E.

**Suite locations:**

| Suite       | Location             | Engine                                                  |
| ----------- | -------------------- | ------------------------------------------------------- |
| Unit        | `/tests/unit`        | Vitest, Bun runtime, no browser                         |
| Integration | `/tests/integration` | Vitest, Bun runtime, real PostgreSQL via testcontainers |
| Component   | `/tests/component`   | Vitest + Playwright (headless Chromium)                 |
| E2E         | `/tests/e2e`         | Vitest + Playwright (headless Chromium)                 |

**No mocks (CLAUDE.md hard rule):** Zero `vi.fn`, `vi.mock`, `vi.spyOn`, `vi.stubGlobal`
in test files. HTTP interception uses MSW v2 `setupServer` at the transport layer so real
`fetch()` executes in every test.

**Database in tests:** testcontainers-node `@testcontainers/postgresql` provisions a real
PostgreSQL 16 instance per test run. No in-memory or SQLite substitute.

**Fixtures:** External API responses committed to `tests/fixtures/` as JSON files. Recorded
by a Bun script against live EDGAR endpoints; re-recorded manually when SEC schema changes.

**E2E:** Playwright as Vitest browser provider (headless Chromium). The Phase 4 "alert pushed
within 1 s" assertion is a merge gate.

**Coverage:** Vitest v8, 99% line threshold.

**Key test surfaces:**

- EDGAR ATOM feed idempotency — duplicate accession number must not produce a duplicate alert
- Alert state machine full happy path and each PRD §5 edge case
- Deduplication across correlated events from multiple release mechanisms
- RLS enforcement — trader A cannot read trader B's alerts
- Task queue stale recovery — claim TTL expiry triggers re-queue
- Replay ledger — genesis, checkpoint, materialized-state comparison, backup restore
- WebSocket latency budget — ≤ 1 s from LISTEN/NOTIFY to browser receipt (Playwright E2E)

---

## Logging and observability

**Structured logging:** pino with PII redaction. Every log line includes `trace_id`,
`service`, and `job_type` (workers) / `user_id` (server, redacted in prod).

**Trace propagation:** OpenTelemetry W3C Trace Context across all HTTP boundaries. Workers
propagate `traceparent` when calling `/internal/...` endpoints. The same `trace_id` threads
from browser request through server through worker log lines.

**Health endpoints (three-tier):**

| Endpoint           | Passes when                          |
| ------------------ | ------------------------------------ |
| `/healthz/live`    | Process is alive                     |
| `/healthz/ready`   | DB connection + task queue reachable |
| `/healthz/startup` | All migrations are current           |

---

## Retention and prune

**Alert archival:** Alerts transition to `Archived` state (PRD §6) after the configured
retention window. Archived alerts are cold-migrated to S3/MinIO in Phase 7.

**Business journal:** 7-year retention (SEC compliance). Cold-tier migration to S3/MinIO
Glacier-class storage after 90 days.

**Dead code:** `knip` runs in CI to flag unused exports. `depcheck` flags unused packages.

**Feature flags:** Stored as PostgreSQL rows. Every flag requires a `scheduled_disable_at`
value. The in-process scheduler enqueues a prune task on the disable date.

---

## Architecture decision log

| Decision             | Choice                               | Rejected alternative                                                       | Reason                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend bundler     | Vite + React 18 SPA                  | Next.js App Router (ux-ts suggestion)                                      | Product is real-time WebSocket-driven; SSR adds no latency benefit. Bun/Hono already owns the server boundary; a second Next.js server would split the auth and WebSocket boundary.                                                                                                                                                                                      |
| Runtime              | Bun ≥ 1.1                            | Node 22 + tsx (process-ts initial pick)                                    | Mandated by arch-ts `IMPL-ARCH-002`; aligns with env blueprint k3d requirement. Bun native TS execution eliminates the tsx/tsc toolchain layer.                                                                                                                                                                                                                          |
| ORM                  | None (`postgres` tagged templates)   | Prisma / Drizzle                                                           | Blueprint data rule requires query-visible SQL. Postgres 16 RLS integration is cleaner without an ORM abstraction layer.                                                                                                                                                                                                                                                 |
| Task queue           | Postgres SKIP LOCKED + LISTEN/NOTIFY | Redis/BullMQ                                                               | Already implemented in `packages/db/task-queue.ts`; satisfies all task-queue blueprint rules; reduces infrastructure dependency count by one stateful service.                                                                                                                                                                                                           |
| Auth provider        | Self-hosted `@simplewebauthn/server` | Auth0 / Clerk                                                              | Trading platform; no SaaS custody of credentials. Passkeys satisfy the MFA requirement without OTP infrastructure.                                                                                                                                                                                                                                                       |
| Schema model         | Domain tables                        | Property graph (`entities`/`relations`/`entity_types` per `IMPL-DATA-002`) | Domain tables with explicit RLS and partition-pruning are simpler to audit and query for regulatory reporting. Fixed regulatory schema makes the graph model's flexibility a liability rather than an asset. This deviation is intentional; do not rewrite to the blueprint default.                                                                                     |
| Server data fetching | TanStack Query v5                    | Native `fetch` + hand-rolled cache                                         | stale-while-revalidate, background refetch, and the `state-matrix.json` loading/empty/error/success states require non-trivial cache management that would otherwise be rebuilt by hand. Passes Buy criteria: critical functionality not feasible at small size; TanStack Query is the most-maintained headless data-fetching library. Logged in `docs/dependencies.md`. |

---

## Open questions (unresolved at Phase 0)

1. **Universe size** — number of tracked securities drives partition sizing and dedup filter
   capacity (PRD §10).
2. **Alert volume SLA** — peak alerts/hour needed to size enrichment worker HPA thresholds
   and claim batch size.
3. **WebSocket fan-out strategy** — sticky sessions (ALB target group) vs. pub/sub relay
   (e.g., Postgres LISTEN in each server pod) for multi-replica `apps/server`. Must be
   resolved before Phase 4.
4. **`ALERT_SUPPLEMENT` task type** — not yet in the task type inventory; needed for amended
   EDGAR filings (`8-K/A`). Add to Phase 3 schema.
5. **Digital twin scope** — does the WORKER blueprint sandbox requirement apply to Phase 3 MVP
   enrichment workers or only to Phase 6 trade execution workers?
6. **Sub-second SLA confirmation** — confirm with stakeholders that the SLA applies to
   `Deduplicated` → WebSocket push segment only, not the full EDGAR-to-outbound-channel
   pipeline (10-minute EDGAR feed cadence makes the full-pipeline interpretation
   unachievable).
7. **Market data price feed** — provider not yet chosen; blocks Phase 3 delta-neutral test
   fixtures and terms extraction.
8. **Trader fine-grained filtering** — filter by event type, sector, and deal size (PRD §10)
   is not scheduled in the plan phases.

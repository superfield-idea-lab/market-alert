# Architecture

## Overview

The product is an ambient AI research associate for finance researchers. Given two
author-owned **golden documents** (Industry Definition and Research Methodology), the
system discovers and scrapes the venues the methodology designates as authoritative,
ingests their findings as canonical sources, synthesizes them into a **living wiki**
organized per knowledge-bearing entity (Company/Ticker, Sub-Industry, Thesis, Event,
Actor, Canonical Source), and continuously distills a compact **standing prompt** (the
trade evaluator). Incoming market events are evaluated against the standing prompt in a
single fast call, producing thesis-aware trade signals that cite back into the wiki.

The system is a TypeScript monorepo with four deployable applications backed by a shared
PostgreSQL 16 database. All asynchronous work flows through a Postgres-native durable
task queue. Workers carry no database credentials; they communicate exclusively through
scoped internal API endpoints. The Knowledge subsystem implements the wiki and
standing-prompt machinery, drawing on the smart-crm reference architecture (polymorphic
entity spine, full-snapshot versioning, append-only fact supersession, status-enum
crash-resume, unified retrieval).

---

## Monorepo layout

```
apps/
  server/        — Hono/Bun HTTP + WebSocket API server
  worker/        — Bun worker processes (source discovery, scraping, ingestion, synthesis, evaluation, delivery)
  web/           — React/Vite researcher dashboard (SPA)
  admin/         — React/Vite admin panel (SPA)
packages/
  core/          — Shared TS types, entity models, state machines, algorithms
  ui/            — Shared design system (shadcn/ui, Tailwind tokens)
  db/            — Postgres schema, migrations, task-queue primitives
  services/      — Internal API clients (server-to-server)
  integrations/  — Third-party SDK wrappers (event feeds, scraping clients, SMTP, SMS)
tests/
  fixtures/      — Committed JSON fixtures (corporate-action feeds, canonical-source scrapes, golden documents)
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
  with `apps/web` but has distinct auth scopes (`signals:admin`, `sources:admin`).
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

All API surfaces are REST. The sole non-REST exception is the WebSocket upgrade path,
which is the only sanctioned real-time transport and is justified by the PRD §9 latency
constraint (event-to-signal evaluation must complete inside the arbitrage window).

**WebSocket transport:** Bun's native `Bun.serve` WebSocket upgrade (no `ws` library). The
LISTEN/NOTIFY → WebSocket push path delivers new signals, wiki-debate notifications, and
standing-prompt rebuild events to the researcher dashboard. Sticky sessions via ALB target
group are required for multi-replica deployments until a pub/sub fan-out strategy is
chosen (see Open questions).

---

## Frontend

**Apps:** `apps/web` (Researcher dashboard) and `apps/admin` (Admin panel) — separate
deployable SPAs sharing `packages/ui`.

**Build:** Vite + `@vitejs/plugin-react` (IMPL-ARCH-003, IMPL-ARCH-010). Compiles to a pure
browser bundle. `apps/server` serves the static assets; no SSR layer.

**Framework:** React 18.x.

**State management:** React Context + `useReducer` (DIY). No Redux or Zustand. The signal
feed is a WebSocket hook updating a single `SignalFeedContext`; the wiki view subscribes
to page-version updates through the same transport.

**Server data fetching:** TanStack Query v5 — handles loading/empty/error/success states
required by UX `state-matrix.json` contracts; stale-while-revalidate for non-real-time views.

**Realtime:** Native browser `WebSocket` connecting to `apps/server` (`wss://`), authenticated
on the HTTP upgrade request via HTTP-only cookie. No third-party relay (no Pusher, Ably).

**UI components:** shadcn/ui — headless Radix UI primitives copy-owned in
`packages/ui/design-system/`, styled with Tailwind CSS 3.x tokens. Components live under
project control; no runtime dependency on an external library version.

**Forms:** DIY controlled React inputs (`useState`). No react-hook-form or Formik. The
golden-document authoring surface, the wiki inline-edit surface, and the agent chat
dialogue are simple enough not to warrant a library.

**Signal feed / data table:** TanStack Table v8 (headless; rendering delegated to design
system components). Supports sort, client-side filter by event type, subject entity,
confidence, and date range, plus column control.

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

**Time partitioning:** `signals` and `market_events` use monthly `RANGE` partitioning on
`created_at` / `detected_at`. Partition pruning keeps query plans bounded as event volume
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
| `mkt_app`       | `mkt_app_rw`      | Read/write on transactional tables (raw filings, task queue, auth)            |
| `mkt_analytics` | `mkt_analytics_w` | INSERT-only on analytics tables (Phase 7 — pool provisioned, idle until then) |
| `mkt_audit`     | `mkt_audit_w`     | INSERT-only on audit/journal tables (`journal_entries`, audit log)            |

No role crosses schema boundaries.

**Row-level security:** PostgreSQL RLS enforces researcher-scoping on all `mkt_kb`
entities (golden documents, wiki pages, facts, signals) and on `mkt_app.task_queue`
rows. `apps/server` runs queries as the `mkt_app_rw` / `mkt_kb_*` roles with RLS active.
Workers never hold database credentials; they call internal endpoints instead.

**Schema inventory:**

| Schema          | Tables                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mkt_app`       | `raw_filings`, `etl_cursors`, `etl_quarantine`, `task_queue`, `passkey_credentials`, `jti_revocations`, `machine_tokens`, `recovery_shards`, `feature_flags`                                                                                                                                                                          |
| `mkt_kb`        | `entities`, `relations`, `entity_versions`, `golden_documents`, `golden_document_sections`, `methodology_meta_commentary`, `canonical_sources`, `source_findings`, `corpus_chunks`, `confirmed_facts`, `wiki_pages`, `wiki_page_versions`, `wiki_debates`, `standing_prompts`, `standing_prompt_versions`, `market_events`, `signals` |
| `mkt_analytics` | Analytics projection tables (Phase 7)                                                                                                                                                                                                                                                                                                 |
| `mkt_audit`     | `journal_entries`, `audit_log`                                                                                                                                                                                                                                                                                                        |

---

## Knowledge subsystem

The wiki, the fact graph, and the standing prompt live in the `mkt_kb` schema and are
the heart of the product. The subsystem adapts five patterns from the smart-crm reference
architecture; each is summarized here with the local adaptation.

### Entity spine (polymorphic, no per-entity DDL)

All knowledge-bearing rows live in `mkt_kb.entities` with `type`, JSON `properties`,
`tenant_id`, and timestamps; a `mkt_kb.relations` table holds typed directed edges
between entities. Adding a new entity kind (a new actor class, a new event type) is a
config registration in `packages/core`, not a migration.

V1 entity types: `company`, `sub_industry`, `thesis`, `event`, `actor`, `canonical_source`,
`source_finding`, `corpus_chunk`, `confirmed_fact`, `wiki_page`, `wiki_page_version`,
`wiki_debate`, `standing_prompt`, `standing_prompt_version`, `signal`,
`golden_document`, `golden_document_section`, `methodology_meta_commentary_entry`.

The product is knowledge-graph-shaped: researchers track many entity kinds across
many sub-industries, and adding a kind must not force a schema migration.

### Wiki pages: full-snapshot versioning

`wiki_page` rows are unique on `(tenant_id, subject_type, subject_id)` and point at a
`currently_published` version through a relation edge. Each rebuild creates a new
`wiki_page_version` row containing the **full markdown body** (encrypted at rest with
AES-256-GCM via the existing KMS-backed envelope); deltas are not stored. Prior
versions are retained indefinitely so the system can replay any past evaluation against
the exact wiki snapshot it used.

Version-status pipeline (status enum):

```
pending → content_written → embedded → indexed
```

Readers follow `wiki_page.currently_published` only when status reaches `indexed`; a
crashed rebuild leaves the version row in its stalled stage and a re-scheduled worker
resumes from the next stage rather than restarting. This is the smart-crm
crash-resume pattern; we adopt it verbatim because it composes cleanly with our
existing `task_queue` retry semantics.

### Confirmed facts: append-only with supersession chain

`confirmed_fact` rows are immutable at the database layer. A Postgres trigger on
`mkt_kb.entities` blocks `UPDATE` and `DELETE` for rows of `type = 'confirmed_fact'`.
Contradiction is expressed by a new row whose `properties.supersedes_fact_id` points
to the prior fact; reads filter to "latest non-superseded per
`(subject_type, subject_id, attribute)`". The prior row is patched only with a
non-content `superseded_by_id` pointer for the audit trail (allowed by a narrow
trigger exception).

When the researcher feedback loop (PRD §5) implies a fact correction, the API inserts
a new fact with `supersedes_fact_id`. The old row stays. There is no destructive edit
path; the audit chain is preserved by construction.

### Citations: first-class relation edges

Wiki claims and facts cite their evidence via typed `cites` edges in `mkt_kb.relations`:

| From                | To                                 | Meaning                                                                 |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `wiki_page_version` | `corpus_chunk` \| `confirmed_fact` | This wiki snapshot is supported by …                                    |
| `wiki_page_version` | `golden_document_section`          | This wiki snapshot derives from a golden-doc section (read-only target) |
| `confirmed_fact`    | `corpus_chunk`                     | This fact was extracted from …                                          |
| `signal`            | `wiki_page_version`                | This signal was reasoned against …                                      |
| `signal`            | `standing_prompt_version`          | This signal was evaluated by …                                          |

On retraction of a `corpus_chunk` (e.g. researcher deletes a note, publisher retracts a
filing), the FK cascade removes the `cites` edges; dependent wiki pages and facts are
not immediately rewritten. The next wiki-rebuild pass sees the missing evidence and
re-derives the affected pages. This trades in-day wiki staleness for atomic batch
rebuild — the same tradeoff smart-crm makes.

### Golden-document enforcement (the invariant from PRD §9)

`golden_document` and `golden_document_section` rows are author-only. Enforcement is
layered:

1. **API layer** — the only write endpoints that target these tables are
   `POST /api/golden-documents/...` and require a researcher session token. Worker
   tokens never resolve to a researcher session, so no worker route can reach those
   endpoints.
2. **Postgres RLS** — RLS policy on `mkt_kb.entities` denies `INSERT`/`UPDATE`/`DELETE`
   on rows where `type IN ('golden_document', 'golden_document_section')` for any role
   other than `mkt_kb_researcher` (used only on the researcher session path).
3. **Trigger backstop** — a row-level trigger on `mkt_kb.entities` re-asserts the rule;
   any write attempt against a golden-doc row from any other role raises and is
   journalled.

Methodology drift accumulates in `methodology_meta_commentary` instead — a separate
agent-writable entity type. The folded-in transition (researcher chooses to update
their golden doc) is a researcher action through the API, not an agent action.

### Standing prompt as derived artifact

`standing_prompt` rows are per-researcher; each rebuild emits a new
`standing_prompt_version` whose markdown body is bounded so evaluation against a
market event is a single fast call. Same status pipeline as `wiki_page_version`. The
distillation worker is triggered on `wiki_page_version` publish events for any page
within the researcher's scope; a debounce window collapses bursts.

### Unified retrieval engine

A single `packages/core/src/retrieval` module exposes
`fetch(subjectType, subjectId, query?)` returning the active wiki version, the latest
non-superseded confirmed facts, and the top-k embedded corpus chunks for the subject
in one call. All consumer surfaces — wiki page view, signal rationale render, debate
inbox, researcher Q&A, audit replay — call this path. The embedding index lives on
`corpus_chunks.embedding` and is rebuilt during the wiki-version `embedded` stage.

### Worker scope and write gating (carries over)

Knowledge workers continue the existing pattern: read-only DB role on the operational
pool, writes through `POST /internal/kb/...` endpoints with a short-lived task-scoped
token bound to `(tenant_id, subject_type, subject_id)`. The API layer holds the RLS
context; workers never see DATABASE_URL.

---

## Authentication and authorization

**Identity:** Self-hosted passkey authentication via `@simplewebauthn/server`. No Auth SaaS.
Passkeys eliminate shared-secret credentials for the Researcher, Reviewer, and Admin
roles (PRD §3).

**Sessions:** ES256 JWTs issued on successful WebAuthn assertion. Stored in HTTP-only,
`SameSite=Strict` cookies. A `jti_revocations` PostgreSQL table enables server-side revocation
(logout, force-expire on credential compromise).

**RBAC:** Scope-based authorization enforced by `requireScope` middleware in `apps/server`.

| Role       | Scopes                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Researcher | `golden_docs:write`, `wiki:read`, `wiki:feedback`, `signals:read`, `signals:acknowledge`, `standing_prompt:pin`, `replay:read` |
| Reviewer   | `signals:read`, `signals:review`, `signals:suppress`                                                                           |
| Admin      | `signals:admin`, `sources:admin`, `replay:read`                                                                                |

The Reviewer role holds the low-confidence signal queue: it can approve, edit, or
suppress signals routed to it before they advance to `Delivered`. PostgreSQL RLS
provides data-layer enforcement in addition to middleware enforcement, and the
golden-document RLS policy (see § Knowledge subsystem) denies every write path except
the Researcher session.

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

## Ingestion

Two ingestion paths run in parallel.

### Market-event feed

A corporate-action event feed (filings + trusted wires) is polled by the event-ingestion
worker.

- **Feed client:** `fast-xml-parser` + native `fetch`. Zero native dependencies.
- **HTTP caching:** In-process `If-Modified-Since` / `ETag` cache. On 304 Not Modified
  the worker short-circuits without creating tasks.
- **Idempotency key:** `edgar_poll:<form_type>:<accession_number>` (or vendor-equivalent
  stable identity). `ON CONFLICT DO NOTHING` on `raw_filings` insert.
- **Watermark:** Per-feed cursor in `mkt_app.etl_cursors`; advanced only after a durable
  write (`land-before-advance`). Out-of-order amendments are handled by an overlap window.
- **Cross-venue dedup:** the same real-world event arriving via different venues
  (wire + later filing) collapses to one `market_event` row via the composite-identity
  key in PRD §9.

### Canonical-source ingestion

For each researcher, source-discovery and scraping workers pull findings from the venues
the methodology designates as authoritative.

- **Source discovery:** the discovery worker reads the active Research Methodology
  golden document, extracts the venue catalog, and registers each venue as a
  `canonical_source` row. Researcher-provided uploads (notes, prior research, thesis
  documents) are registered as canonical sources of subtype `researcher_provided`.
- **Scraping:** the scraper worker pulls each `canonical_source` on its declared
  cadence, respecting venue rate limits, robots policy, and access mode. Each scraped
  payload becomes a `source_finding` row; the worker stores a `content_hash` for dedup
  and a forward link to the source.
- **Chunking:** the ingestion worker parses each finding into `corpus_chunk` rows
  (atomic text fragments). Chunks carry the back-link to the finding.
- **Fact extraction:** the fact-extraction worker reads new chunks and emits
  `confirmed_fact` rows attached to the relevant subject entity. Contradictions follow
  the supersession chain (see § Knowledge subsystem).
- **Quarantine and DLQ:** malformed payloads land in `etl_quarantine`; failed tasks land
  in the task-queue DLQ. Neither blocks the queue.

---

## Signal routing

When a market event is detected (or an Expected event passes silently), the event
evaluator applies the researcher's active standing prompt to the event and produces a
`signal` row. Routing then depends on the signal's confidence (PRD §5, §9):

| Confidence path     | Condition                                       | Destination                                                                 |
| ------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| **Direct delivery** | Confidence at or above the configured threshold | `Generated` → `Delivered` via WebSocket push + outbound channels            |
| **Reviewer queue**  | Confidence below the threshold                  | Routed to Reviewer queue; advances to `Delivered` only on Reviewer approval |

Confidence is decomposed into source trust (the tier of the supporting wiki claims, per
the researcher's methodology) and extraction certainty (how unambiguously the event
maps to the standing prompt); both factors are stored on the `signal` row so the
methodology can tune them independently.

The evaluation step itself is a single fast model call against the compact standing
prompt. The signal carries citations into the wiki snapshot and standing-prompt revision
used; both are immutable, supporting the auditability constraint in PRD §9.

Reviewer approval or suppression writes a journal entry and transitions the signal to
`Delivered` or `Suppressed` respectively.

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

| Task type                 | Delivery      | Priority | Idempotency key                                      |
| ------------------------- | ------------- | -------- | ---------------------------------------------------- |
| `EDGAR_POLL`              | At-least-once | Normal   | `edgar_poll:<form>:<accession>`                      |
| `SOURCE_DISCOVER`         | At-least-once | Low      | `src_discover:<researcher_id>:<methodology_version>` |
| `SOURCE_SCRAPE`           | At-least-once | Normal   | `src_scrape:<canonical_source_id>:<cursor>`          |
| `FINDING_INGEST`          | At-least-once | High     | `ingest:<source_finding_id>`                         |
| `FACT_EXTRACT`            | At-least-once | High     | `fact_extract:<corpus_chunk_id>`                     |
| `WIKI_REBUILD`            | At-least-once | High     | `wiki_rebuild:<subject_type>:<subject_id>:<trigger>` |
| `WIKI_DEBATE_RESOLVE`     | At-least-once | Normal   | `debate:<wiki_debate_id>`                            |
| `STANDING_PROMPT_DISTILL` | At-least-once | High     | `sp_distill:<researcher_id>:<wiki_version_window>`   |
| `EVENT_EVALUATE`          | At-least-once | High     | `event_eval:<market_event_id>`                       |
| `SILENT_PASSAGE_CHECK`    | At-least-once | Low      | `silent_check:<expected_event_id>:<window_close>`    |
| `SIGNAL_NOTIFY`           | At-least-once | Normal   | `notify:<signal_id>:<channel>`                       |
| `META_COMMENTARY_OPEN`    | At-least-once | Low      | `meta:<researcher_id>:<feedback_id>`                 |

**Stale recovery:** Worker heartbeat via `updated_at`. Claims older than the per-type TTL are
re-queued by the stale-recovery cron. Each task type has an independent `claim_expires_at`
configuration (slow enrichment requires a longer TTL than fast settlement).

**Scheduled tasks:** Application-level in-process scheduler (not pg_cron). A `scheduler`
singleton in `apps/server` enqueues periodic tasks (EDGAR poll cadence, stale recovery,
retention sweep) on startup.

**Queue depth metric:** `pg_query_exporter` exposes
`task_queue_pending_total{job_type="..."}` as a Prometheus gauge.

**Autoscaling:** KEDA `prometheus` trigger drives Kubernetes HPA for worker Deployments.
Scale targets are the high-priority queue depths (`EVENT_EVALUATE`, `WIKI_REBUILD`,
`FINDING_INGEST`, `FACT_EXTRACT`, `SOURCE_SCRAPE`). Singleton workers (the event-feed
poller, per-researcher source-discovery and standing-prompt distiller) are not HPA-scaled.

**DLQ replay:** Manual via admin panel. DLQ items are queryable and re-queueable from
`apps/admin`.

---

## Workers

Ten worker classes, each a separate Kubernetes Deployment in `apps/worker`:

| Worker                    | Task types                               | Concurrency                         |
| ------------------------- | ---------------------------------------- | ----------------------------------- |
| Event ingestion poller    | `EDGAR_POLL`                             | 1 pod (singleton)                   |
| Source-discovery worker   | `SOURCE_DISCOVER`                        | 1 per researcher                    |
| Scraper worker            | `SOURCE_SCRAPE`                          | HPA on `SOURCE_SCRAPE` queue depth  |
| Ingestion worker          | `FINDING_INGEST`                         | `max_tasks` batch                   |
| Fact extraction worker    | `FACT_EXTRACT`                           | `max_tasks` batch                   |
| Wiki rebuild worker       | `WIKI_REBUILD`, `WIKI_DEBATE_RESOLVE`    | HPA on `WIKI_REBUILD` queue depth   |
| Standing-prompt distiller | `STANDING_PROMPT_DISTILL`                | 1 per researcher (debounced)        |
| Event evaluator           | `EVENT_EVALUATE`, `SILENT_PASSAGE_CHECK` | HPA on `EVENT_EVALUATE` queue depth |
| Signal delivery worker    | `SIGNAL_NOTIFY`                          | `max_tasks` batch                   |
| Meta-commentary writer    | `META_COMMENTARY_OPEN`                   | 1 per researcher                    |

**Process model:** Single-threaded Bun event loop per pod. No worker threads at MVP scale. HPA
adds pod replicas when queue depth exceeds the KEDA threshold. Workers hold no database
connection; the `EventSource` SSE client to `GET /api/v1/tasks/stream` is the only persistent
connection they maintain.

**Graceful shutdown:** `process.on('SIGTERM')` stops claiming new tasks, drains in-flight
tasks up to a configurable timeout, then exits. No external shutdown library required (~30
lines in `apps/worker/src/runner.ts`).

**Latency budget:** The PRD §9 latency constraint applies to the `Detected` →
`Delivered` segment of the signal lifecycle and must complete inside the arbitrage
window for the V1 corporate-action event types. Internal hops (event normalization,
standing-prompt evaluation, WebSocket push to the dashboard) sit on the latency path.
Outbound channels (email, SMS, webhook) are dispatched asynchronously by the signal
delivery worker and are not on the latency path; `SIGNAL_NOTIFY` failures are
non-blocking. The `Delivered` state is set on WebSocket push completion.

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
by a Bun script against the live event feed and canonical-source venues; re-recorded
manually when an upstream schema changes.

**E2E:** Playwright as Vitest browser provider (headless Chromium). The end-to-end
event-to-delivered-signal assertion is a merge gate.

**Coverage:** Vitest v8, 99% line threshold.

**Key test surfaces:**

- Event-feed idempotency — duplicate accession (or vendor-equivalent identity) must not produce a duplicate `market_event`
- Cross-venue deduplication — wire-leading-filing-by-days collapses to one `market_event`
- Signal lifecycle full happy path and each PRD §5 edge case
- Golden-document invariant — every write path from a worker token against `golden_document` rows is rejected at the API, RLS, and trigger layers
- Append-only fact trigger — `UPDATE`/`DELETE` against `confirmed_fact` rows is blocked; supersession chain produces a new row
- Wiki rebuild crash-resume — a worker that fails between status stages resumes from the stalled stage
- Standing-prompt distillation idempotency — re-running the distiller on the same wiki version yields no new `standing_prompt_version`
- RLS enforcement — researcher A cannot read researcher B's wiki, facts, or signals
- Task queue stale recovery — claim TTL expiry triggers re-queue
- Replay ledger — genesis, checkpoint, materialized-state comparison, backup restore
- Signal latency — `Detected` → `Delivered` inside the configured arbitrage window (Playwright E2E)

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

**Signal archival:** Signals transition to `Archived` state (PRD §6) after the
configured retention window. Archived signals are cold-migrated to S3/MinIO. Wiki
versions, standing-prompt versions, canonical sources, source findings, and confirmed
facts follow their own retention policies (see PRD §10 open questions) and are
cold-migrated on the same path.

**Business journal:** 7-year retention. Cold-tier migration to S3/MinIO Glacier-class
storage after 90 days.

**Dead code:** `knip` runs in CI to flag unused exports. `depcheck` flags unused packages.

**Feature flags:** Stored as PostgreSQL rows. Every flag requires a `scheduled_disable_at`
value. The in-process scheduler enqueues a prune task on the disable date.

---

## Architecture decision log

| Decision               | Choice                                                                                                                                     | Rejected alternative                      | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend bundler       | Vite + React 18 SPA                                                                                                                        | Next.js App Router                        | The researcher dashboard is real-time WebSocket-driven for signals, wiki updates, and debate notifications; SSR adds no latency benefit. Bun/Hono owns the server boundary; a second Next.js server would split the auth and WebSocket boundary.                                                                                                                                                                                            |
| Runtime                | Bun ≥ 1.1                                                                                                                                  | Node 22 + tsx (process-ts initial pick)   | Mandated by arch-ts `IMPL-ARCH-002`; aligns with env blueprint k3d requirement. Bun native TS execution eliminates the tsx/tsc toolchain layer.                                                                                                                                                                                                                                                                                             |
| ORM                    | None (`postgres` tagged templates)                                                                                                         | Prisma / Drizzle                          | Blueprint data rule requires query-visible SQL. Postgres 16 RLS integration is cleaner without an ORM abstraction layer.                                                                                                                                                                                                                                                                                                                    |
| Task queue             | Postgres SKIP LOCKED + LISTEN/NOTIFY                                                                                                       | Redis/BullMQ                              | Already implemented in `packages/db/task-queue.ts`; satisfies all task-queue blueprint rules; reduces infrastructure dependency count by one stateful service.                                                                                                                                                                                                                                                                              |
| Auth provider          | Self-hosted `@simplewebauthn/server`                                                                                                       | Auth0 / Clerk                             | Researcher data and golden documents are confidential; no SaaS custody of credentials. Passkeys satisfy the MFA requirement without OTP infrastructure.                                                                                                                                                                                                                                                                                     |
| Schema model           | Property graph (`mkt_kb.entities` + `mkt_kb.relations`) for the Knowledge subsystem; domain tables retained for transactional / audit data | Pure domain tables for knowledge entities | The product is knowledge-graph-shaped — researchers track many entity kinds (Company, Sub-Industry, Thesis, Event, Actor, Canonical Source, Confirmed Fact, Wiki Page, Wiki Debate, Standing Prompt, Signal, plus methodology meta-commentary). Fixed domain tables would force a migration on every new entity kind. Transactional and audit tables (task queue, journal, auth) stay as domain tables — those schemas are not pluralistic. |
| Versioning             | Full markdown snapshots (`wiki_page_version`, `standing_prompt_version`)                                                                   | Delta storage                             | Smart-crm pattern. Full snapshots make replay a row lookup, not a fold. Indefinite retention is the cost; storage is cheap relative to the audit guarantee that PRD §9 requires.                                                                                                                                                                                                                                                            |
| Fact mutability        | Append-only with supersession chain on `confirmed_fact`                                                                                    | Mutable rows                              | Smart-crm pattern. A Postgres trigger blocks `UPDATE`/`DELETE` on `confirmed_fact` rows. Contradictions are new rows pointing at the prior via `supersedes_fact_id`. Preserves the audit chain by construction; researcher corrections create new facts, not destructive edits.                                                                                                                                                             |
| Rebuild concurrency    | Status-enum crash-resume on version rows                                                                                                   | Distributed lock or optimistic CAS        | Smart-crm pattern. The `pending → content_written → embedded → indexed` enum is both the work pipeline and the resume marker. Readers see only `indexed`. Composes with the existing task-queue retry semantics; no separate lock service.                                                                                                                                                                                                  |
| Golden-doc enforcement | API gate + RLS policy + row trigger (defense in depth)                                                                                     | API gate alone                            | The golden-document invariant in PRD §9 is product-defining. Triple enforcement makes accidental agent writes impossible even under a misconfigured worker token.                                                                                                                                                                                                                                                                           |
| Server data fetching   | TanStack Query v5                                                                                                                          | Native `fetch` + hand-rolled cache        | stale-while-revalidate, background refetch, and the `state-matrix.json` loading/empty/error/success states require non-trivial cache management that would otherwise be rebuilt by hand. Passes Buy criteria: critical functionality not feasible at small size; TanStack Query is the most-maintained headless data-fetching library. Logged in `docs/dependencies.md`.                                                                    |

---

## Open questions

1. **Universe size per researcher** — number of tracked entities (companies + canonical
   sources + theses) drives `mkt_kb.entities` partition sizing and embedding-index
   memory budget. Anchored in PRD §10.
2. **Event volume SLA** — peak market events per minute needed to size the event
   evaluator HPA thresholds and the standing-prompt-distillation debounce window.
3. **WebSocket fan-out strategy** — sticky sessions (ALB target group) vs. pub/sub
   relay (e.g., Postgres LISTEN in each server pod) for multi-replica `apps/server`.
4. **Wiki rebuild trigger granularity** — per-finding vs. per-batch vs. per-debounced-window. Drives `WIKI_REBUILD` queue depth and tail latency to wiki freshness.
5. **Standing-prompt distillation cadence** — what governs how aggressively the
   distiller fires (time-based, change-volume-based, event-anticipation-based). PRD §10.
6. **Wiki-debate surfacing** — badge on page, queue, or digest. Drives the dashboard
   debate inbox design.
7. **Confidence threshold** — value of the source-trust × extraction-certainty product
   below which a signal is routed to the Reviewer queue rather than delivered directly.
8. **Reviewer SLA** — how long before an unreviewed low-confidence signal auto-expires
   or escalates to direct delivery.
9. **Retention windows** — for canonical sources, source findings, wiki versions,
   standing-prompt versions, and signals. PRD §10.
10. **Source-discovery scope** — does the methodology enumerate venues exhaustively, or
    may the system propose new venues for the researcher's approval via methodology
    meta-commentary. PRD §10.

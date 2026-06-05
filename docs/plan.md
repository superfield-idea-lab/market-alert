# Implementation Plan — Market Alert Trading System

<!-- last-edited: 2026-05-03 -->
<!-- review-applied: 2026-05-03 — corrected stale references, health endpoint paths, added apps/admin to Phase 0, aligned DB pool inventory, added ALERT_SUPPLEMENT to task queue scaffold, added WebSocket sticky-session note to Phase 4 -->
<!-- source-decision: 2026-05-01 — EDGAR RSS/ATOM feed is the sole v1 ingestion source; multi-vendor adapter layer deferred to v2 -->

CONTEXT MAP
this ──implements─────▶ docs/prd.md (trading system PRD)
this ──references─────▶ docs/architecture.md (system architecture)
this ──references─────▶ blueprint/rules/blueprints/ (arch, auth, data, deploy, env, process, prune, task-queue, test, ux, worker)

---

## About this document

This plan implements the trading system PRD at `docs/prd.md`: an event-driven
arbitrage hedge fund alert platform that detects corporate actions (M&A, dividends,
spinoffs) from multiple vendor sources, enriches them, deduplicates, and delivers
sub-second alerts to traders.

The plan is grounded in `docs/architecture.md`, which defines the canonical monorepo
layout, runtime decisions, data layer, task queue design, and all architectural
decision log (ADL) entries. Where the PRD and blueprint conflict, blueprint requirements
are non-negotiable and override PRD intent.

---

## PRD vs. Blueprint gap analysis

The PRD (`docs/prd.md`) is thin in places where the blueprints are strict.
Every gap below is a required addition, not optional polish.

### Critical conflicts

**PRD §9: "minimal audit logging for MVP"**
The DATA and DEPLOY blueprints require a fully isolated audit store from the first
commit that touches customer or market data. `DATA-D-004` mandates an append-only
hash-chained audit store on a disjoint role; `DEPLOY-D-001` requires audit events to
precede sensitive reads. The PRD's intent to defer audit is structurally blocked by the
blueprint. The plan treats comprehensive audit as a Phase 1 gate, not a post-MVP concern.

**PRD: no authentication mechanism specified**
The AUTH blueprint mandates passkey-only (FIDO2 WebAuthn) from the first user-facing
commit (`AUTH-D-001`, `AUTH-X-001`). No password fallback, no magic-link fallback, ever.
The Trader and Admin roles described in the PRD must authenticate exclusively via passkey.

**PRD: no data encryption requirements stated**
The DATA blueprint requires field-level AES-256-GCM encryption for all sensitive fields
before storage (`DATA-C-023`). In the trading context this means: alert content, enriched
trade terms, SEC filing text, trader identity fields. These must be encrypted at rest with
KMS-managed keys from Phase 1.

**PRD §9: "replay" treated as a single bullet point**
The blueprint's task queue (`TQ-D-001` through `TQ-D-006`) and the DATA blueprint's
business journal (`DATA-D-004`) define the replay substrate. Event replay is not a
standalone feature; it is a consequence of routing all state changes through the task
queue and audit log. The plan wires this correctly rather than treating it as
a custom feature.

### Blueprint requirements the PRD does not address

| Topic                        | Blueprint rule                 | Required addition                                                                              |
| ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Passkey authentication       | `AUTH-D-001`, `AUTH-X-001`     | Phase 1 — passkey login for Trader and Admin                                                   |
| Three-pool Postgres          | `DATA-D-006`, `DATA-C-001`     | Phase 0/1 — `mkt_app`, `mkt_audit`, `mkt_analytics` with disjoint roles (see architecture.md)  |
| Audit store isolation        | `DATA-D-004`, `DATA-C-026`     | Phase 1 — append-only, hash-chained, own role                                                  |
| Field-level encryption       | `DATA-C-023`                   | Phase 1 — sensitive alert and user fields                                                      |
| Worker writes via API only   | `WORKER-D-001`, `WORKER-D-002` | Phase 3 — enrichment workers call API, no direct DB                                            |
| Task queue (not ad-hoc cron) | `TQ-D-001`–`TQ-D-006`          | Phase 0 — cron is a producer; workers are consumers                                            |
| k3d dev environment          | `ENV-D-002`                    | Phase 0 — no Docker Compose                                                                    |
| Twelve-check CI gate         | `PROCESS-D-011/013/014/015`    | Phase 0 — 99% line coverage                                                                    |
| Feature flags table          | `PRUNE-D-002`, `PRUNE-A-003`   | Phase 0 — vendor gates backed by DB rows                                                       |
| Design system skeleton       | `UX-D-001`, `UX-D-004`         | Phase 0 — tokens + one primitive + service flow maps                                           |
| Zero mocks in tests          | `TEST-C-018`                   | All phases — `vi.fn`/`vi.mock` banned                                                          |
| Vendor fixture recording     | `TEST-D-001`, `TEST-C-003`     | Phase 0 — EDGAR ATOM feed via MSW fixtures; v2 vendor fixtures added when sources are licensed |
| Deployment audit record      | `DEPLOY-D-006`, `DEPLOY-C-035` | Phase 0 — `deployments.jsonl`                                                                  |

---

## Planning principles (from blueprint)

- **Scout-gated phases.** Each phase begins with one scout issue that proves the phase's
  architectural assumptions before any follow-on issues may land.
- **One issue at a time.** Finish the selected issue through merge before starting the next.
- **Workers write via API.** Enrichment workers, ingestion pollers, and deduplication workers
  have no database credentials; all writes route through `POST /internal/...` endpoints with
  scoped short-lived tokens.
- **Task queue everywhere.** Cron inserts task rows; workers claim them via `SELECT … FOR
UPDATE SKIP LOCKED`. No ad-hoc cron workers.
- **Real-time delivery = LISTEN/NOTIFY + WebSocket.** Sub-second alert delivery to the UI
  is achieved by task queue LISTEN/NOTIFY triggering a WebSocket push; the task queue model
  is not bypassed.
- **Passkey-only from first login.** No passwords, no magic links, ever.
- **Audit before read.** A failed audit write denies the read. Compliant with `DATA-C-026`.
- **No mocks.** Zero `vi.fn`, `vi.mock`, `vi.spyOn` in test files. External vendor API
  responses are recorded fixtures under `tests/fixtures/`; vendor HTTP is intercepted by MSW v2.

---

## Phase overview

| #   | Phase                                | Scout delivers                                                                 | Gates |
| --- | ------------------------------------ | ------------------------------------------------------------------------------ | ----- |
| 0   | Scaffolding & infrastructure         | Monorepo, twelve-check CI, k3d dev cluster, task queue, feature flags          | —     |
| 1   | Security foundation                  | Three-pool Postgres, passkey login, RLS, field encryption, audit isolation     | 0     |
| 2   | EDGAR ingestion worker               | One 8-K filing stored, filing text encrypted, `ALERT_ENRICH` task queued       | 1     |
| 3   | Alert enrichment pipeline            | SEC filing retrieval + terms extraction + dedup: one enriched alert end-to-end | 2     |
| 4   | Real-time alert delivery & trader UI | WebSocket push: alert delivered to trader UI within 1 s of enrichment          | 3     |
| 5   | Admin panel & source configuration   | Admin can toggle a vendor source on/off; config survives restart               | 1, 4  |
| 6   | Trade lifecycle tracking             | Trade entity state machine: Proposed → Executed → Settled → Reconciled         | 4     |
| 7   | Event streaming & replay             | Full event replay from audit log; point-in-time state reconstruction           | 1     |

---

## Phase 0 — Scaffolding & infrastructure

**Goal.** A new commit on `main` builds, tests, lints, migrates a dev Postgres, and
deploys a trivial service to a k3d cluster, all behind a twelve-check CI gate.

**Scout issue.** _Scaffold the monorepo and land a "hello" service behind the full
twelve-check CI gate._ Deliverables: `apps/server`, `apps/web`, `apps/worker`,
`apps/admin`, `packages/core`, `tests/` skeleton per ARCH blueprint; three health
endpoints (`/healthz/live`, `/healthz/ready`, `/healthz/startup` —
`DEPLOY-C-030/031/032`); one empty trader route in the web app; one empty admin route
in the admin app; CI pipeline with build, lint, format, unit, integration, e2e,
coverage, checklist, depends-on, issue-checklist, conflicts, and single-issue checks
— 99% coverage threshold; `pnpm dev` = k3d cluster create + kubectl apply (not Docker
Compose — `ENV-D-002`). `docs/dependencies.md` checked in as Phase 0 deliverable
(`ARCH-C-005`).

**Follow-on issues.**

- **k3d dev cluster scaffold** — reuse existing `k8s/` manifests as baseline. `pnpm dev`
  boots the full topology: api-server, worker, postgres, ingress. Ephemeral test DB
  containers on randomised ports for integration tests (`ENV-D-003`).
- **Task queue scaffold** — `packages/db/task-queue.ts` is already implemented with
  the full blueprint-conformant queue: `FOR UPDATE SKIP LOCKED` atomic claim
  (`claimNextTask`), stale-claim recovery with exponential backoff (`recoverStaleClaims`,
  `2^attempt` seconds), DLQ via `status = 'dead'` with `checkDlqAlertThreshold`,
  idempotent enqueue on conflict (`enqueueTask`), and LISTEN/NOTIFY triggers firing on
  `task_queue_<agent_type>` channel at insert. The worker runner in `apps/worker/src/runner.ts`
  already uses this pattern with `runWorkerLoop`.

  For the trading system, extend `TaskType` and `TASK_TYPE_AGENT_MAP` in
  `packages/db/task-queue.ts` with the following new types — preserving existing types for
  the KB substrate, adding trading types alongside:

  | TaskType constant     | agent_type string | Worker                                       | Trigger                                    |
  | --------------------- | ----------------- | -------------------------------------------- | ------------------------------------------ |
  | `EDGAR_POLL`          | `edgar_ingest`    | Ingestion worker                             | Cron every 10 min                          |
  | `ALERT_ENRICH`        | `enrichment`      | Enrichment worker                            | Enqueued by `edgar_ingest`                 |
  | `ALERT_DEDUP`         | `enrichment`      | Same enrichment worker, `job_type` sub-route | Enqueued after enrich                      |
  | `ALERT_NOTIFY`        | `notification`    | Notification worker                          | Enqueued on `Deduplicated`                 |
  | `ALERT_SUPPLEMENT`    | `enrichment`      | Same enrichment worker, `job_type` sub-route | Enqueued on amended EDGAR filing (`8-K/A`) |
  | `CORP_ACTION_ADVANCE` | `scheduler`       | Scheduler worker                             | Cron on effective/settlement date          |
  | `TRADE_SETTLE`        | `scheduler`       | Same scheduler worker, `job_type` sub-route  | Cron on settlement date                    |

  Add per-type views `task_queue_view_edgar_ingest`, `task_queue_view_enrichment`,
  `task_queue_view_notification`, `task_queue_view_scheduler` in `packages/db/schema.sql`,
  following the existing `task_queue_view_*` pattern.

  Task queue status machine (existing, do not change):
  `pending → claimed → running → submitting → completed | failed | dead`
  `claimed → pending` on stale recovery (attempt < max_attempts)
  `claimed → dead` on stale recovery (attempt ≥ max_attempts)

  DLQ alert threshold remains `DLQ_ALERT_THRESHOLD = 10` dead tasks per agent_type.
  Payload no-PII validator (`TQ-C-004`) applied to all new task types at enqueue.
  Idempotency key format for `EDGAR_POLL`: `edgar_poll:<form_type>:<accession_number>`.

- **Feature flags table** — `feature_flags` table + evaluation middleware. All source
  and channel gates backed by DB rows from day one (`PRUNE-D-002`, avoids `PRUNE-A-003`).
  v1 flags to seed: `edgar_ingest` (off by default; must be enabled before first poll),
  `alert_notify_email`, `alert_notify_sms`, `alert_notify_webhook`, `trade_lifecycle`.
  Future vendor sources (Bloomberg, DealReporter, etc.) get their own flag rows when
  licensed — no code change required to activate.
- **Golden fixture recorder** — tool records real HTTP request/response pairs for each
  vendor source API to `tests/fixtures/vendor/`; 30-day refresh pipeline; schema drift
  alerts (`TEST-D-001`, `TEST-C-003/019/025`). MSW v2 handlers wired against each
  fixture before any vendor integration code is written.
- **Design system skeleton** — color/type/space tokens, one button primitive, static
  catalog page, Playwright screenshot review loop. Service flow maps for all seven
  subsequent phases land here as documentation (design, not code) so Phase 4 builds from
  an existing design system (`UX-D-001`, `UX-C-001`, `UX-D-004`, `UX-C-002`).
- **Structured logger + PII scrub + dual log** — nothing ever logs PII; dual log
  (chronological + uniques dedup) + browser error forwarding from the first request
  (`DEPLOY-D-002/003`, `DEPLOY-C-008/010`).
- **Trace-ID propagation browser → server → DB** (`DEPLOY-D-004`). Given a trace ID,
  all related log entries retrievable in one query (`DEPLOY-C-021`).
- **Deployment audit record** — `deployments.jsonl` written on every deployment with
  timestamp, operator, release tag, environment, outcome, image digest
  (`DEPLOY-D-006`, `DEPLOY-C-035`).
- Golden-path e2e test: boots the stack, hits `/healthz/live`, tears down. Canary for
  every subsequent PR.

**Exit criteria.** CI is all-green on a PR that only changes a comment. Dev onboarding
is `git clone && pnpm install && pnpm dev` with k3d. All twelve CI check names
pre-registered in GitHub before branch protection is enabled.

---

## Phase 1 — Security foundation

**Goal.** The data layer is RLS-restrictive, field-encrypted, auditable, and
unreachable except through authenticated sessions. No market or user data can be stored
until this phase is merged. The PRD's deferred audit intent is overridden here by
blueprint requirements.

**Scout issue.** _End-to-end vertical slice: passkey login → authenticated API call →
RLS-scoped read of a test entity → audit event written before the read commits._
The scout proves the full identity → session → RLS-context → audit-first → encrypted-read
chain for a single entity type. Nothing else in Phase 1 may land until this is merged.

**Follow-on issues.**

- **Three-pool Postgres architecture** — `mkt_app` (`mkt_app_rw`), `mkt_audit`
  (`mkt_audit_w`), `mkt_analytics` (`mkt_analytics_w`) with disjoint roles and disjoint
  KMS key domains, as specified in `docs/architecture.md`. The `mkt_analytics` pool starts
  empty; populated in Phase 7. No operational role can read the audit pool. Pool
  permissions per the architecture ADL: `mkt_app_rw` reads/writes transactional tables;
  `mkt_audit_w` is INSERT-only on `mkt_audit` schema; `mkt_analytics_w` is INSERT-only
  on `mkt_analytics` schema.
- **Passkey registration + login** — FIDO2 WebAuthn only; no password, no magic link.
  SameSite=Strict cookies, HTTP-only, Secure. Trader and Admin roles both use passkey.
  Reuse existing `apps/server/src/auth/` passkey implementation rather than rewriting.
- **Passkey key recovery flow** — recovery passphrase + second factor → re-enrollment
  of new passkey. Recovery events notify all enrolled devices (`AUTH-D-007`,
  `AUTH-C-016/017`, avoids `AUTH-X-008`).
- **Token refresh rotation, progressive lockout, generic error messages** — each refresh
  produces a new token and invalidates the old (`AUTH-C-018`); failed attempts trigger
  progressive delays (`AUTH-C-024`); all auth errors are generic (`AUTH-C-032`).
- **Field-level AES-256-GCM encryption** for sensitive fields: alert content, trade
  terms, SEC filing text, trader name/email, any enrichment output that references
  real parties. KMS-managed keys partitioned by sensitivity class. HSM-backed staging KMS
  (`DATA-C-023`). Key rotation ≤ 90 days.
- **Audit store** — append-only, hash-chained `journal_entries` table in the `mkt_audit`
  schema. Audit writes precede sensitive reads; a failed audit write denies the read.
  Operational role cannot read or modify audit data. Written exclusively via `mkt_audit_w`
  pool.
- **Restrictive RLS policies** — one policy test per role per table. Admin cannot read
  another tenant's data; Trader cannot read another Trader's private alert notes.
- **Business journal distinct from audit log** — audit log is the access trail; journal
  is replay-able facts for consequential operations (alert state transitions, trade state
  changes). Ledger replay tests: genesis replay, checkpoint replay, materialized-state
  comparison (`DATA-D-004`, `DATA-C-026/027`).
- **Auth incident response runbook** — four scenarios tested before any market data lands:
  signing key compromise, agent credential compromise, admin account compromise, mass
  session invalidation (`AUTH-C-030`). Must be executed against staging environment.
- **JWT/session hardening** — algorithm pinned at deploy (ES256; no header negotiation),
  JTI revocation replay protection (`jti_revocations` table in `mkt_app`), CSRF
  double-submit on all cookie-authenticated mutations.
- **mTLS service mesh** (Linkerd) — all pod-to-pod traffic mutually authenticated.
  Worker → API, API → Postgres calls use short-lived workload identities.
- **Rate limiting** — auth endpoints + API endpoints that could be probed.
- **Machine tokens for workers** — scoped machine API tokens stored in AWS Secrets Manager,
  rotated weekly. Workers carry no `DATABASE_URL`; all DB writes routed through
  `POST /internal/...` endpoints validated by `worker-tokens.ts`.

**Exit criteria.** An Admin test session cannot read a Trader's private alert note even
when it tries directly; the database blocks it. Audit query against any sensitive read
returns a matching event. Key rotation can be invoked end-to-end against HSM-backed
staging KMS. Auth incident runbook executed for all four scenarios.

---

## Phase 2 — EDGAR ingestion worker

**Goal.** EDGAR RSS/ATOM feed is the sole v1 data source. One real SEC filing lands as
a stored `CorporateAction` entity with its full filing text, queued for enrichment.
No vendor contracts or API keys required.

**Why EDGAR as the only v1 source.** EDGAR is free, public, and authoritative — the
commercial vendors (Bloomberg, DealReporter, etc.) largely repackage it. The EDGAR RSS
feed updates every 10 minutes. Filing text is already in-hand at ingestion, which
collapses the separate SEC-fetch step from the original Phase 3 design. Vendor adapters
are a v2 concern and stay dark behind feature flags until licensed.

**EDGAR feed endpoints (no auth required):**

- RSS/ATOM current filings: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=<form>&output=atom`
- Full-text search API: `https://efts.sec.gov/LATEST/search-index?q=...&dateRange=custom&...`
- Filing index: `https://www.sec.gov/Archives/edgar/full-index/`

**In-scope form types for v1** (covers all PRD corporate action event types):

| Form                  | Event type                                       | PRD mapping                        |
| --------------------- | ------------------------------------------------ | ---------------------------------- |
| `8-K`                 | Material corporate events (M&A, dividends, etc.) | Primary M&A + dividend detection   |
| `SC 13D` / `SC 13G`   | Beneficial ownership ≥ 5%                        | Activist / ownership change signal |
| `S-4`                 | Merger registration statement                    | Deal confirmation + terms          |
| `425`                 | Merger-related communications                    | Supplemental deal terms            |
| `DEF 14A` / `DEFM14A` | Proxy statement / merger proxy                   | Vote date, shareholder approval    |

**Scout issue.** _EDGAR RSS end-to-end_: cron inserts one `EDGAR_POLL` task row; the
`edgar_ingest` worker claims it via `claimNextTask({ agent_type: 'edgar_ingest' })`,
fetches the EDGAR `8-K` ATOM feed (MSW v2 fixture in CI), parses one filing entry,
stores the raw XML/text, and calls `POST /internal/ingestion/corporate-action` with the
normalised entity; the API validates, writes the `CorporateAction` row, and enqueues an
`ALERT_ENRICH` task. Worker submits the task result via `POST /api/tasks/:id/result`
with its delegated token, matching the existing `submitResultViaApi` pattern in
`apps/worker/src/runner.ts`. No enrichment yet — this proves ingestion end-to-end.

**Follow-on issues.**

- **EDGAR ingestion worker** (`apps/worker/src/edgar-ingest-job.ts`) — implements the
  `EDGAR_POLL` job type. Fetches the ATOM feed for each configured form type, parses
  entries since the last-seen `accession_number` (stored in `mkt_app.etl_cursors`
  per-form-type cursor), deduplicates via
  `idempotency_key = 'edgar_poll:<form_type>:<accession_number>'`, and calls
  `POST /internal/ingestion/corporate-action` per new filing. In-process
  `If-Modified-Since` / `ETag` cache short-circuits on 304 Not Modified.
  Egress restricted to `www.sec.gov` and `efts.sec.gov` only (`WORKER-C-024`).
  Registered in `apps/worker/src/runner.ts` alongside existing job types.
- **Cron producer** — cron inserts `EDGAR_POLL` task rows every 10 minutes (matching EDGAR
  feed refresh cadence). Poll interval configurable via `feature_flags` table row — not a
  hard-coded constant (`PRUNE-A-003`). Gated by `edgar_ingest` feature flag (off by default;
  must be enabled before first ingest run).
- **`POST /internal/ingestion/corporate-action` endpoint** — validates the normalised
  payload (no direct DB writes from worker — `WORKER-D-001`), writes `CorporateAction`
  entity to `mkt_app`, stores raw filing text (field-level encrypted), and enqueues
  `ALERT_ENRICH`. Scoped ingestion token verified via existing `worker-tokens.ts` pattern.
- **Normalised `CorporateAction` entity** — fields: `source` (always `'edgar'` in v1),
  `accession_number` (idempotency key), `form_type`, `event_type`
  (`M&A | dividend | spinoff | ownership_change | proxy | merger_comms`), `ticker`,
  `cik`, `filing_url`, `filing_text` (encrypted), `announced_at`, `effective_date`,
  `settlement_date`, `state` (`Announced | Effective | Closed | Disputed`),
  `raw_payload_hash`, `retention_class`, `legal_hold`. Monthly `RANGE` partitioning on
  `announced_at` per `docs/architecture.md` data layer spec.
- **Corporate Action state machine** — implements PRD §6 lifecycle:
  `Announced → Effective → Closed → Disputed`. Cron inserts `CORP_ACTION_ADVANCE` tasks
  on `effective_date` and `settlement_date`; `scheduler` worker calls
  `PATCH /internal/corporate-actions/:id/advance`. Admin forces `→ Disputed` via
  `POST /internal/corporate-actions/:id/dispute`; journal compensation event written.
  Every transition is a business journal entry.
- **Raw filing store** — append-only; stores the original EDGAR XML/HTML filing text
  alongside the normalised entity for replay (`DATA-D-004`). Retention class written at
  ingestion. Long-term archival to AWS S3/MinIO with Object Lock (WORM mode).
- **Ingestion worker HPA** — Kubernetes HPA on `edgar_ingest` worker deployment; scale
  metric: `EDGAR_POLL` task queue depth via KEDA `prometheus` trigger.
  `MAX_WORKER_CONCURRENCY` configurable via env. Queue depth alert fires at 80% of
  throttle threshold.
- **EDGAR fixture** — one complete recorded EDGAR ATOM feed response (8-K + S-4) captured
  via the golden fixture recorder from Phase 0 and committed to `tests/fixtures/edgar/`.
  MSW v2 handler intercepts all `sec.gov` calls in CI. Zero live EDGAR calls in automated
  tests. 30-day fixture refresh scheduled pipeline refreshes the fixture and alerts on
  schema drift.
- **Backup + restore runbook** — written and tested before any market data lands. Recovery
  path must exist as soon as real data reaches the system.
- **Observability wiring** — ingestion pipeline metrics exported via `pg_query_exporter`
  (`task_queue_pending_total{job_type="edgar_ingest"}`). pino structured logs with
  `trace_id`, `service`, and `job_type` on every worker line.

**Exit criteria.** A recorded EDGAR 8-K ATOM fixture replayed by an integration test
produces one `CorporateAction` row with encrypted `filing_text`, zero PII in any
worker-visible column, and one `ALERT_ENRICH` task in the queue, all verified end-to-end
with no live network calls.

---

## Phase 3 — Alert enrichment pipeline

**Goal.** An enrichment worker processes a queued corporate action, extracts structured
deal terms from the already-stored filing text, calculates a delta-neutral impact estimate,
and writes an enriched `Alert` entity back through the API. The deduplication engine is
wired. No outbound calls to EDGAR — all necessary text arrived in Phase 2.

**Scout issue.** _Minimal enrichment vertical slice_: single `CorporateAction` with
`filing_text` already stored (from Phase 2), enrichment worker claims one `ALERT_ENRICH`
task, runs terms extraction against the stored filing text, writes an `Alert` entity in
`Enriched` state through `POST /internal/alerts`. Dedup runs after. Sub-second delivery
not yet wired — this scout proves the enrichment pipeline and API-mediated-write invariants.
No separate SEC fetch step — the filing text is already in-hand from Phase 2.

**Follow-on issues.**

- **Enrichment worker** (`apps/worker/src/alert-enrich-job.ts`) — implements `ALERT_ENRICH`,
  `ALERT_DEDUP`, and `ALERT_SUPPLEMENT` job types within the `enrichment` agent type, using
  the existing multi-`job_type` dispatch pattern in `runner.ts`. Fetches
  `CorporateAction.filing_text` via `GET /internal/corporate-actions/:id` with its
  delegated token. No outbound calls to EDGAR — text already stored in Phase 2. Network
  policy blocks worker → DB (`WORKER-C-006`); egress restricted to `api-server` only
  (`WORKER-C-024`). Uses `cheerio` for HTML filing text extraction; regex/rule-based terms
  extraction for v1 (AI-driven extraction via Claude Sonnet deferred to v2 per PRD §8).
- **Terms extraction** — parses stored EDGAR filing XML/HTML text: extracts
  deal value, target/acquirer, cash/stock split, conditions, expected close date. Produces
  structured `DealTerms` sub-entity. Partial extraction is expected and handled: any
  `DealTerms` field that cannot be extracted is set to `null` with an `extraction_confidence`
  flag (`full | partial | failed`). Alerts with `extraction_confidence: failed` still
  advance to `Enriched` and are delivered to traders marked as incomplete — never silently
  dropped or stalled.
- **Out-of-order event handling** — EDGAR may publish an amended filing (`8-K/A`) or a
  related form (`S-4`, `425`) after the original `8-K`. Each EDGAR filing carries its own
  `filed_at` timestamp; the normalised `CorporateAction` uses the earliest `filed_at` as
  `announced_at` and updates `effective_date` when a later filing provides a more authoritative
  date. A new filing for an existing `accession_number` is deduplicated at ingestion; a new
  filing for the same `(ticker, event_type)` with an earlier `filed_at` re-opens the
  `ALERT_ENRICH` task if the alert has not yet reached `Delivered`. Post-`Delivered` amended
  filings enqueue an `ALERT_SUPPLEMENT` task, delivered as an update to the existing alert.
  The overlap window in `etl_cursors` re-scans recent accession numbers to catch
  out-of-order amendments.
- **Delta-neutral impact calculation** — computes estimated arbitrage spread and
  delta-neutral exposure from deal terms + current price data. Price data fetched from a
  configured market data source (feature-flagged; dev uses fixture). Best-effort in Phase 3;
  falls back to raw spread if market data source unavailable.
- **Deduplication engine** — cross-source dedup after enrichment: if two enriched alerts
  represent the same corporate action from different sources, merge into one alert with
  multiple `source_references`. Dedup key: `(ticker, event_type, announced_at ± 24h)`.
  Dedup decisions journaled. `ALERT_DEDUP` task enqueued after `ALERT_ENRICH` completes.
- **Alert entity write path** — `POST /internal/alerts` with enriched payload; worker
  token scoped to `(alert_type, source)`. Alert created in `Enriched` state; transitions
  to `Deduplicated` after dedup pass. Monthly `RANGE` partitioning on `created_at` per
  architecture.md.
- **Alert state machine** — implements PRD §6 state machine:
  `Pending → Detected → Enriched → Deduplicated → Delivered → Acknowledged → Archived`.
  Every transition is a journal entry; reversions produce a business journal compensation
  event.
- **Claim-citation coverage** — every enriched alert must cite its source `CorporateAction`
  entity (identified by `accession_number`). Uncited alerts are routed to the DLQ with a
  P1 marker.
- **Enrichment digital twin sandbox** — enrichment workers run against a sandbox clone of
  the production-state slice; promotion to real state requires API-layer confirmation
  (`DATA-D-011`, `WORKER-D-006`, `WORKER-C-011/012`).

**Exit criteria.** A recorded EDGAR 8-K fixture produces one enriched `Alert` row with
structured `DealTerms` (partial or full), a dedup decision in the business journal, and
the `CorporateAction` accession number as citation, all via API-mediated writes with zero
direct DB writes from any worker container and no live network calls.

---

## Phase 4 — Real-time alert delivery & trader UI

**Goal.** An authenticated Trader receives a push notification in the web UI within 1
second of an alert transitioning to `Deduplicated` state. The alert displays enriched
details. Trader can acknowledge.

**Scout issue.** _WebSocket push to trader dashboard_: one alert goes from `Deduplicated`
to `Delivered` via a LISTEN/NOTIFY-triggered WebSocket push to an authenticated trader
session. The trader UI renders the alert with basic fields. No filtering, no full
enriched detail — those land after the scout proves the real-time path.

**Follow-on issues.**

- **WebSocket server** — authenticated WebSocket endpoint in `apps/server` using Bun's
  native `Bun.serve` WebSocket upgrade (no `ws` library). Session validated on upgrade via
  same HTTP-only cookie/JWT as HTTP. Trader session subscribes to their watchlist-filtered
  alert channel. Heartbeat + reconnect with exponential backoff. For multi-replica
  deployments, sticky sessions via ALB target group are required until a pub/sub fan-out
  strategy is chosen (architecture.md open question #3). The LISTEN/NOTIFY → WebSocket
  push path must deliver within 1 second of an alert reaching `Deduplicated` state.
- **LISTEN/NOTIFY trigger** — `pg_notify` fired on alert `Deduplicated` state transition
  via a dedicated `postgres` LISTEN connection in `apps/server` (separate from the main
  `mkt_app` pool). WebSocket server receives it and pushes to all connected trader sessions
  that have the alert's ticker in their watchlist. Simultaneously enqueues an `ALERT_NOTIFY`
  task for outbound channels.
- **Trader dashboard** — alert feed sorted by timestamp, newest first. Each alert shows:
  ticker, event type, deal terms summary, sources, spread estimate, timestamp, status badge.
  RLS: trader sees only alerts for tickers on their watchlist (`mkt_app` RLS enforced).
  State management: React Context + `useReducer` (`AlertFeedContext`) — no Redux/Zustand
  per architecture.md. Server data fetching via TanStack Query v5. Alert list rendered with
  TanStack Table v8.
- **Alert detail view** — full enriched detail: deal terms, SEC filing excerpt, all source
  references, delta-neutral impact, citation links.
- **Acknowledge action** — Trader transitions alert from `Delivered` to `Acknowledged`
  via `POST /api/alerts/:id/acknowledge`. Audit event written. Optimistic UI update with
  rollback on error.
- **Watchlist management** — Trader can add/remove tickers from their watchlist via the
  settings page. Watchlist changes immediately affect which alerts are pushed.
- **Alert filtering** — client-side filter by event type, expected close date range,
  minimum spread threshold via TanStack Table v8 column filters.
- **Playwright e2e suite** — happy path (alert pushed within 1 s) + wrong-trader RLS
  path (trader cannot see another trader's private notes) — run on real headless Chromium
  (`TEST-C-018`). The "alert pushed within 1 s" assertion is a merge gate.
- **Outbound notification delivery** — `ALERT_NOTIFY` task worker dispatches to all
  enabled outbound channels for each trader on the watchlist. Channel adapters (each
  feature-flag-gated, default off):
  - **Email** — SMTP adapter (`packages/integrations`); sends enriched alert summary.
  - **SMS** — pluggable SMS provider adapter (`packages/integrations`); sends ticker +
    event type + spread one-liner.
  - **Webhook** — per-trader configurable outbound webhook URL (`packages/integrations`);
    POST with signed HMAC payload containing the full enriched alert JSON. Signature uses
    a per-trader secret stored encrypted in `mkt_app`.
    Alert transitions to `Delivered` after WebSocket push completion. Channel failures are
    non-blocking: a failed email does not block the WebSocket push. Each channel failure is
    an audit event. Retry via DLQ with exponential backoff.
- **"Propose trade from alert" CTA** — alert detail view includes a "Propose trade" button
  that navigates to the Phase 6 trade form with `alert_id`, `ticker`, and inferred
  `direction` pre-populated. Button is hidden until Phase 6 ships; displayed as a
  disabled stub in Phase 4 to preserve the UI slot. Gated by the `trade_lifecycle`
  feature flag (`false` until Phase 6 exits).

**Exit criteria.** In a CI environment, a seeded alert transition triggers a WebSocket
push received by a connected trader session within 1 second, verified by a Playwright
e2e test running on real Chromium. The same alert triggers a recorded MSW fixture for
the email and webhook adapters. A second trader session proves RLS blocks cross-trader
reads at the database layer.

---

## Phase 5 — Admin panel & source configuration

**Goal.** An Admin can manage vendor source on/off state, override false-positive alerts,
view system health metrics per source, and read the audit trail. The admin panel runs in
`apps/admin` (separate deployable SPA, shares `packages/ui` with `apps/web`, distinct
`alerts:admin` and `sources:admin` auth scopes).

**Scout issue.** _Source toggle and health view_: Admin can disable EDGAR ingestion (set
`edgar_ingest` feature flag row to `false`) via the admin UI; the cron producer stops
inserting `EDGAR_POLL` tasks; health dashboard shows EDGAR as inactive. Proves the
feature-flag-backed source configuration path before alert override or audit views land.

**Follow-on issues.**

- **Admin dashboard shell** — authenticated Admin-only layout in `apps/admin`; RLS blocks
  non-Admin sessions from all admin endpoints at the database layer. Auth scopes:
  `alerts:admin`, `sources:admin`.
- **Vendor source configuration UI** — list of all configured sources with on/off toggle,
  polling interval, circuit breaker status, last-seen-event timestamp. Each change writes
  to the `feature_flags` table and the business journal; effective immediately.
- **Alert override / suppression** — Admin can mark an alert as `suppressed` (false
  positive), add a suppression reason, and optionally suppress all future alerts matching
  the same `(ticker, event_type)` pattern. Suppressed alerts are excluded from trader
  delivery. All overrides audited.
- **System health metrics** — per-source: event ingestion rate, last success/failure
  timestamps, circuit breaker state, enrichment queue depth. Uses `mkt_analytics`
  aggregated view (not `mkt_app` direct queries — `DATA-X-003`).
- **Audit trail view** — Compliance-style read-only view of audit events: actor, action,
  target entity, timestamp. Paginated, exportable as CSV (itself an audit event).
- **Alert volume and latency dashboards** — alert volume per source per hour; p50/p95
  delivery latency (time from vendor receipt to trader acknowledgement). Persisted in
  `mkt_analytics`.
- **Bulk alert export** — structured JSON export of alerts for a date range, audited.
- **DLQ replay** — DLQ items queryable and re-queueable from `apps/admin` per
  architecture.md task queue DLQ replay spec.

**Exit criteria.** Admin disables a vendor source via the UI; the ingestion worker's next
poll cycle finds the feature flag `false` and skips; the health dashboard updates within
the next metric polling interval; the disable action appears in the audit trail.

---

## Phase 6 — Trade lifecycle tracking

**Goal.** Traders can record a proposed trade linked to an alert and advance it through
the full `Proposed → Executed → Settled → Reconciled` lifecycle.

**Scout issue.** _Propose and execute a trade from an alert_: Trader arrives from the
Phase 4 "Propose trade" CTA with `alert_id` pre-populated, submits the form, and the
trade is written as `Proposed` through `POST /api/trades`. Trader then marks it `Executed`
via `PATCH /api/trades/:id`. RLS ensures only the owning Trader can read or modify the
trade. Proves the trade write path, `alert_id` linkage, and state machine before
settlement or reconciliation land. The Phase 4 feature flag `trade_lifecycle` flips to
`true` when this scout merges, activating the previously stubbed CTA.

**Follow-on issues.**

- **Trade entity** — fields: `alert_id` (FK to the originating alert), `trader_id`,
  `ticker`, `direction` (long/short), `notional`, `executed_price`, `executed_at`,
  `settlement_date`, `state`, `reconciliation_notes`. Field-level encryption on price and
  notional fields. RBAC scopes: `trades:propose`, `trades:execute`.
- **Trade state machine** — `Proposed → Executed → Settled → Reconciled`. Each transition
  is a business journal entry. Disputed state (`Disputed`) reachable from any post-`Executed`
  state on Admin override; journal compensation event required.
- **Settlement tracking** — settlement date tracked; on settlement date, cron inserts
  `TRADE_SETTLE` task; scheduler worker marks trade `Settled` via
  `PATCH /internal/trades/:id/settle`.
- **Reconciliation** — Trader or Admin records post-trade reconciliation notes; trade
  transitions to `Reconciled`. Reconciliation records are append-only (no editing).
- **Trade history view** — Trader dashboard tab listing their trades: state badges,
  linked alert, timeline, journal entries. RLS: each Trader sees only their own trades.
  Forms use DIY controlled React inputs (`useState`) per architecture.md frontend spec.
- **Admin trade oversight** — Admin can view all trades (aggregate, not per-trader detail)
  and can mark a trade `Disputed` with a reason. Trader notified via WebSocket.

**Exit criteria.** A Trader proposes a trade from an alert, a second Trader proves they
cannot see it (RLS at DB layer), the first Trader advances it to `Executed` and `Settled`,
and the full state timeline appears in the journal replay.

---

## Phase 7 — Event streaming & replay

**Goal.** Any authorized user can replay the full event history for a corporate action or
a trade from the audit log and business journal, arriving at the correct point-in-time
state. Export path available for compliance or debugging purposes.

**Scout issue.** _Corporate action replay end-to-end_: given a `corporate_action_id`,
replay all journal entries from genesis to current state and assert the materialized state
matches the live `CorporateAction` entity. Proves the journal-as-replay-substrate approach
before the API or export path land.

**Follow-on issues.**

- **Replay API** — `GET /api/replay/corporate-actions/:id` and `/api/replay/trades/:id`
  return the ordered journal entries that produced the current state. Response includes
  each state transition with actor, timestamp, and input payload hash. RBAC scope:
  `replay:read`.
- **Point-in-time state query** — `?at=<ISO8601>` parameter reconstructs entity state
  at an arbitrary historical timestamp from the journal. Useful for debugging and
  compliance review.
- **Event stream subscription** — server-sent events endpoint for Admin to stream live
  journal events for a given entity. Same RLS rules as the read endpoint.
- **Structured replay export** — Admin exports a point-in-time bundle (journal +
  audit trail + entity snapshots) for a corporate action, date range, or trader, in
  structured JSON. Export itself is an audit event. Replays are verified by the
  `mkt_analytics` materialisation and compared against the live `mkt_app` state.
- **Analytics tier population** — materialise pseudonymised session events and aggregated
  alert/trade metrics into `mkt_analytics`. BDM-style queries execute against
  `mkt_analytics`, not `mkt_app` (`DATA-D-006`, `DATA-D-007`, `DATA-C-010/011`, avoids
  `DATA-X-003`). Session pseudonyms rotate per session via HMAC-SHA256.
- **Cold archival** — alerts in `Archived` state cold-migrated to S3/MinIO. Business
  journal: 7-year retention (SEC compliance); cold-tier migration to S3/MinIO
  Glacier-class storage after 90 days.
- **30-day fixture refresh** — scheduled CI job refreshes all vendor fixtures via the
  golden fixture recorder from Phase 0; schema drift detection alerts on changes.

**Exit criteria.** A replay API call for a seeded corporate action returns the ordered
journal with the correct state sequence; point-in-time query at an intermediate timestamp
returns the correct intermediate state; the materialized analytics value matches the live
entity count.

---

## Cross-cutting work

Items that are not scout-eligible but must land with or before the phases that need them.

| Concern                                       | Lands with | Rationale                                                                            |
| --------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Structured logging + PII scrub + dual log     | Phase 0    | Nothing ever logs PII; dual log (chronological + uniques) + browser error forwarding |
| Trace-ID propagation (browser → server → DB)  | Phase 0    | End-to-end from browser side; needed from first real request                         |
| k3d cluster + task queue + design system      | Phase 0    | Foundation; Docker Compose never used                                                |
| Feature flags for all sources and channels    | Phase 0    | `edgar_ingest`, notify channels, `trade_lifecycle` all backed by DB flag rows        |
| `docs/dependencies.md` (Buy/DIY log)          | Phase 0    | `ARCH-C-005` deliverable; all runtime deps must be justified before code lands       |
| mTLS service mesh (Linkerd)                   | Phase 1    | Required before any multi-service traffic with market data                           |
| KMS integration (HSM-backed)                  | Phase 1    | Field encryption is a Phase 1 gate; KMS must be HSM-backed in staging                |
| Rate limiting (auth + API)                    | Phase 1    | Auth endpoints from first login; alert query path from first enriched alert          |
| Auth incident response runbook                | Phase 1    | Must predate any market data landing                                                 |
| Observability (metrics, traces)               | Phase 2    | Ingestion pipeline has a sub-second latency SLA                                      |
| Backup + restore runbook                      | Phase 2    | As soon as market data lands, a recovery path must exist                             |
| Deployment audit record (`deployments.jsonl`) | Phase 0    | Required before first staged deployment                                              |

---

## Open questions

Not blocking issue creation, but must be resolved before the phase they affect begins.

| Question                                                 | Blocks              | Proposed default                                                                                                         |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Target security universe size                            | Phase 2             | Defer until answered; start with configurable max-tickers param                                                          |
| Expected alert volume (per second peak)                  | Phase 2, Phase 4    | EDGAR publishes ~500–2000 filings/day total; design for burst of 50 filings/min; load test required before Phase 2 exits |
| Which EDGAR form types are in scope for v1?              | Phase 2             | 8-K, SC 13D/G, S-4, 425, DEF 14A/DEFM14A — confirmed in this plan; confirm with product owner                            |
| Which form types map to which event_type?                | Phase 2             | Initial mapping in plan; rule-based classifier needed for 8-K item codes                                                 |
| Fine-grained trader filtering (sector, deal size)?       | Phase 4             | `event_type` filter in Phase 4; sector/deal-size in v2                                                                   |
| Delta-neutral impact: required v1 or v2?                 | Phase 3             | Best-effort in Phase 3; fallback to raw spread if market data source unavailable                                         |
| Market data source for spread calculation?               | Phase 3             | Needs a free or contracted price feed; open until resolved                                                               |
| Outbound channel priority (email vs. SMS vs. webhook)?   | Phase 4             | All three gated off by default; Admin enables per-tenant; Trader sets preference                                         |
| WebSocket fan-out strategy for multi-replica server?     | Phase 4             | Sticky sessions (ALB target group) for MVP; pub/sub relay deferred; must be resolved before Phase 4 merges               |
| Webhook integration with external trading systems?       | Phase 6             | Per-trader outbound webhook in Phase 4; trading-system API integration is v2                                             |
| Vendor sources (Bloomberg, DealReporter, etc.) timeline? | v2                  | All dark behind feature flags; no v1 commitment                                                                          |
| AI-driven alert filtering?                               | PRD §8 out-of-scope | Confirmed out of scope for v1                                                                                            |

---

## Risks & mitigations

| Risk                                                   | Impact                                 | Mitigation                                                                                                                  |
| ------------------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Sub-second delivery SLA                                | Phase 4 slips                          | Scout benchmarks full path before any Phase 4 feature work lands                                                            |
| EDGAR feed schema changes                              | Phase 2 ingest silently breaks         | 30-day fixture refresh + schema drift alerts; EDGAR ATOM format is very stable (unchanged since 2006)                       |
| EDGAR rate limiting (10 req/sec per IP)                | Phase 2 poller throttled               | Poll interval matches EDGAR feed cadence (10 min); one request per form type per poll; well within limits                   |
| Deduplication false-merges create missed alerts        | P1 trader impact                       | Dedup decisions journaled; any merge can be reversed; Phase 3 integration tests cover all edge cases with recorded fixtures |
| Out-of-order late events corrupt enriched alert        | Wrong deal terms delivered to traders  | Sequence-gap detection re-opens enrichment task if alert not yet `Delivered`; supplement path for post-delivery late events |
| Partial terms extraction silently blocks delivery      | Alert stuck in `Enriched` indefinitely | `partial` extraction confidence flag ensures alert advances regardless; null fields surfaced explicitly in UI               |
| Ingestion worker overwhelmed at peak volume            | Queue depth grows unboundedly          | HPA on `EDGAR_POLL` queue depth via KEDA; load test required at Phase 2 exit                                                |
| RLS policy authoring is error-prone                    | Silent cross-trader data leaks         | Every RLS policy has a dedicated integration test asserting the block; Phase 4 e2e verifies at the DB layer                 |
| Outbound channel (email/SMS/webhook) delivery failures | Trader misses alert                    | Channel failures non-blocking; DLQ + audit event per failure; alert still `Delivered` if WebSocket push succeeded           |
| Corporate Action effective date wrong from vendor      | Traders acting on stale spread window  | EDGAR filing overrides vendor date when available; Admin can manually correct via `Disputed` transition                     |
| PRD "minimal audit" intent vs. blueprint requirement   | Phase 1 compliance debt                | Resolved: comprehensive audit is Phase 1; PRD intent overridden by blueprint                                                |
| Feature creep from open questions                      | Plan becomes unachievable              | v2 features explicitly excluded; open questions stay here until a v2 plan is drafted                                        |
| WebSocket sticky-session limit                         | Horizontal scale blocked past MVP      | Documented as open question; must be resolved before Phase 4 exits                                                          |

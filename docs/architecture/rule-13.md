# Rule 13: worker — Worker Processes

## Summary of the blueprint rule

The WORKER blueprint governs all asynchronous, CPU-bound task execution in the platform.
Its central invariant is that worker containers have **zero database connectivity**: no
credentials, no network path to port 5432, no read-only database connection of any kind.
All application-state access — task discovery, data reads, result submission — flows
through the API server using per-type service tokens and short-lived delegated user tokens.

Key principles and design patterns:

- **WORKER-P-001 (zero-database-connectivity).** Workers hold no DATABASE_URL, PGPASSWORD,
  or any database credential. The database is structurally unreachable at the network level
  from a worker container. This is a harder guarantee than read-only access.
- **WORKER-P-002 (writes-through-authenticated-api).** Every state change a worker
  produces is submitted as an authenticated API request. The API validates, authorizes,
  and writes through the standard data layer. Workers are not trusted insiders.
- **WORKER-P-006 (single-use-task-scoped-tokens).** The API issues a short-lived,
  task-scoped delegated token at task creation. The worker uses it exactly once to submit
  a result; the token is invalidated on first use and expires by TTL if unused.
- **WORKER-P-008 (agent-type-isolation).** Each agent type carries its own per-type
  service token. A token for one type cannot subscribe to another type's SSE stream,
  claim another type's tasks, or submit results under another type's identity.
- **WORKER-P-009 (general-purpose-async-execution).** Workers handle all async CPU-bound
  tasks, not only AI workloads. The API server is HTTP-only: it creates task_queue entries
  and returns; it never executes CPU-bound work.
- **WORKER-D-001 (api-streaming-task-discovery).** Workers discover tasks exclusively via
  SSE (GET /api/v1/tasks/stream). The API server holds the LISTEN connection to PostgreSQL
  and fans pg_notify events to connected workers over SSE. Workers have no direct database
  subscription.
- **WORKER-D-007 (per-agent-type-service-token).** Each agent type is deployed with a
  dedicated Kubernetes Secret carrying its service token. Adding a new agent type requires
  issuing a new token and explicit infrastructure review — it is an architectural decision.
- **WORKER-D-008 (worker-spawning-model).** Two spawning models: long-running poll loop
  (persistent replica) for high-frequency task types; short-running k8s Job for rare,
  heavyweight tasks. Both use the same claim-execute-submit lifecycle.
- **WORKER-P-004 (distroless-with-explicit-allowances).** Worker images have no shell,
  no package manager, no ad-hoc debugging tools. Allowances (writable temp directory,
  CA bundles, vendor credentials) are explicit and predeclared.
- **WORKER-D-005 (structured-execution-audit-log).** Every task claim, vendor API call,
  and result submission is logged to the audit table via the API. Log entries contain
  hashes of inputs/outputs, not plaintext content.

Key antipatterns explicitly prohibited: direct database access (WORKER-X-001), shared
service tokens across agent types (WORKER-X-002), broad-scope delegated tokens
(WORKER-X-003), long-lived delegated tokens (WORKER-X-004), and shell-form CLI invocation
(WORKER-X-006).

## TypeScript implementation specifics

There is no `worker-ts.yaml`. TypeScript worker implementation is governed jointly by
**task-queue-ts.yaml** (IMPL-TASK-QUEUE domain) and **process-ts.yaml** (IMPL-PROCESS
domain). The following points synthesize the two:

### From task-queue-ts.yaml

- **IMPL-TQ-TS-007 (worker-sse-client).** The worker daemon connects to
  `GET /api/v1/tasks/stream?token=<service_token>` using the native `EventSource` API
  available in Bun. On every `task_available` or `heartbeat` event, the worker calls
  `POST /api/v1/tasks/claim` with its service token. `EventSource` reconnects
  automatically with exponential backoff.
- **IMPL-TQ-TS-008 (worker-startup-credential-guard).** The worker binary checks for
  `DATABASE_URL`, `PGPASSWORD`, `PGHOST`, `PGUSER`, and `PGDATABASE` at startup. If any
  are present, the worker logs an error and exits with status 1 before opening any
  connections. Implemented in `apps/worker/src/startup-guard.ts`.
- **IMPL-TQ-TS-010 (worker-kubernetes-manifest).** Each agent type has a dedicated
  Kubernetes Deployment. The pod spec includes: a `Secret` mount for the per-type
  `SERVICE_TOKEN` only (no `DATABASE_URL`); a `NetworkPolicy` that allows egress to the
  API server and declared vendor API hostnames only — port 5432 is not listed;
  `TASK_QUEUE_STREAM_URL` pointing to the API server's SSE endpoint.
- **IMPL-TQ-TS-X-001 (worker-pg-import).** Importing `postgres`, `pg`, or any PostgreSQL
  client library into the worker package is an antipattern. CI must verify via
  `package.json` inspection that no database client appears in `apps/worker/package.json`
  or any package it depends on.

### From process-ts.yaml

- **IMPL-PROCESS-003 (feature-unit-invariant).** One feature = one branch = one worktree
  = one pull request. Each worker type (edgar_ingest, enrichment, notification, scheduler)
  is developed as a distinct feature issue.
- **IMPL-PROCESS-004 (single-orchestrator-per-repo).** The CLI orchestrates workflow
  state, task dispatch, gate evaluation, and operator interaction. Workers are not
  orchestrators; they execute single task types.
- **IMPL-PROCESS-006 (structured-agent-outcomes).** Worker task completions produce
  structured outcomes: `OK`, `NOK`, or `ABORTED`. These map to task_queue statuses
  `completed`, `failed`, and `dead` respectively.

### Combined pattern in practice

A TypeScript worker is a Bun process in `apps/worker/src/` that:

1. Runs `startup-guard.ts` to abort on any database credential in the environment.
2. Connects to the SSE endpoint using `EventSource`.
3. On each event, calls the claim endpoint and receives a task payload including a
   delegated token.
4. Executes domain work (HTTP calls to external APIs, parsing, calculation).
5. Submits the result via `POST /api/tasks/:id/result` with the delegated token, using
   the existing `submitResultViaApi` pattern in `apps/worker/src/runner.ts`.
6. The delegated token is invalidated by the API on first use.

Multiple job types within one agent type are dispatched via a `job_type` sub-route in
`runner.ts` (e.g., `enrichment` agent type handles both `ALERT_ENRICH` and `ALERT_DEDUP`
job types through the same claim loop).

## Application to market-alert PRD/plan

The plan (Phase 0 task queue scaffold) defines six trading task types across four agent
types. Below is the full worker inventory:

### Worker inventory

| Worker              | agent_type     | Task types handled                    | Spawning model         | Trigger                                     |
| ------------------- | -------------- | ------------------------------------- | ---------------------- | ------------------------------------------- |
| Ingestion worker    | `edgar_ingest` | `EDGAR_POLL`                          | Long-running poll loop | Cron every 10 min (feature-flag-gated)      |
| Enrichment worker   | `enrichment`   | `ALERT_ENRICH`, `ALERT_DEDUP`         | Long-running poll loop | Enqueued by `edgar_ingest` and after enrich |
| Notification worker | `notification` | `ALERT_NOTIFY`                        | Long-running poll loop | Enqueued on `Deduplicated` state transition |
| Scheduler worker    | `scheduler`    | `CORP_ACTION_ADVANCE`, `TRADE_SETTLE` | Long-running poll loop | Cron on effective/settlement dates          |

All four are long-running poll loops (WORKER-D-008, persistent-replica model), because
task volume is expected to be continuous and startup overhead would compound across
frequent cron triggers.

### Worker-by-worker analysis

**Ingestion worker (`edgar_ingest`).**
Polls the EDGAR RSS/ATOM feed via the SSE → claim loop. Fetches one or more SEC form-type
feeds (8-K, SC 13D, SC 13G, S-4, 425, DEF 14A), parses entries since last-seen
`accession_number`, deduplicates via `idempotency_key = 'edgar_poll:<form_type>:<accession_number>'`,
and calls `POST /internal/ingestion/corporate-action` per new filing. The API validates,
writes the `CorporateAction` entity to `mkt_app`, encrypts `filing_text`, and enqueues
`ALERT_ENRICH`. Network egress restricted to `www.sec.gov` and `efts.sec.gov` only
(WORKER-C-024). Gated by `edgar_ingest` feature flag; cron inserts no tasks while the
flag is `false`.

Idempotency is enforced at the task-queue level (unique constraint on `idempotency_key`)
and at the entity level (`accession_number` is the idempotency key for `CorporateAction`).
If the cron fires twice within the same 10-minute window, the second `EDGAR_POLL` task
creation is rejected by the unique constraint (TQ-D-008, TQ-P-003).

**Enrichment worker (`enrichment`).**
Handles both `ALERT_ENRICH` and `ALERT_DEDUP` job types within one agent type via
`job_type` sub-routing. For `ALERT_ENRICH`: fetches `CorporateAction.filing_text` via
`GET /internal/corporate-actions/:id` (text already stored in Phase 2 — no separate EDGAR
fetch), runs regex/rule-based terms extraction to produce a `DealTerms` sub-entity
(full/partial/failed confidence), calculates delta-neutral impact, then calls
`POST /internal/alerts` to create the `Alert` in `Enriched` state. For `ALERT_DEDUP`:
applies dedup key `(ticker, event_type, announced_at ± 24h)`, merges duplicate alerts
into one with multiple `source_references`, journals the dedup decision, and transitions
the alert to `Deduplicated`. Network policy: egress to `api-server` only (WORKER-C-006,
WORKER-C-024). No direct EDGAR calls.

Idempotency: the delegated token is single-use (WORKER-P-006); a crashed enrichment
worker re-enters `pending` via stale-claim recovery (TQ-D-003) and is retried with a new
delegated token. Out-of-order EDGAR amendments (8-K/A) re-open the `ALERT_ENRICH` task
if the alert has not yet reached `Delivered`; post-`Delivered` amendments emit an
`ALERT_SUPPLEMENT` task (not a full re-enrichment).

**Notification worker (`notification`).**
Claims `ALERT_NOTIFY` tasks, dispatches to all enabled outbound channels per trader on
the watchlist: Email (SMTP), SMS (pluggable adapter), Webhook (HMAC-signed POST). Each
channel is feature-flag-gated. Channel failures are non-blocking; a failed email does not
block the WebSocket push. Retries via DLQ with exponential backoff. Alert transitions to
`Delivered` only after all enabled channels for that trader have dispatched or failed after
retry. Each channel failure is an audit event written via the API.

Idempotency: each `ALERT_NOTIFY` task is scoped to `(alert_id, trader_id, channel)` to
prevent duplicate outbound dispatch on retry.

**Scheduler worker (`scheduler`).**
Handles `CORP_ACTION_ADVANCE` (calls `PATCH /internal/corporate-actions/:id/advance` to
drive the `Announced → Effective → Closed → Disputed` state machine) and `TRADE_SETTLE`
(drives `Proposed → Executed → Settled → Reconciled`). Every state transition is a
business journal entry. Admin-forced `→ Disputed` transitions come through an Admin API
endpoint, not the scheduler worker. Cron inserts tasks on `effective_date` and
`settlement_date` using date-windowed idempotency keys.

### Sub-second latency obligations (PRD §9)

The PRD states sub-second detection-to-notification is non-negotiable. Workers satisfy
this through the LISTEN/NOTIFY + SSE architecture:

1. Enrichment worker transitions alert to `Deduplicated` via API write.
2. PostgreSQL trigger fires `pg_notify` on alert state transition.
3. API server's LISTEN connection receives the notify and fans it via WebSocket to trader
   sessions with matching watchlist tickers (Phase 4 WebSocket push, distinct from the
   task queue SSE).
4. WebSocket push delivers the alert to the trader browser.
5. Simultaneously, `ALERT_NOTIFY` task is enqueued for outbound channel dispatch.

The task queue SSE stream (worker → API) and the trader notification WebSocket (API →
browser) are separate channels. The WebSocket delivery bypasses the notification worker's
claim loop for the UI push; the notification worker handles slower outbound channels
(email, SMS, webhook) asynchronously.

Latency budget: the pg_notify → WebSocket delivery leg targets < 100 ms. Enrichment
processing (terms extraction, delta-neutral calculation) is the main variable. Partial
extraction (confidence: `partial` or `failed`) must not stall the pipeline; incomplete
alerts advance to `Enriched` and are delivered marked as incomplete.

### Horizontal scaling and ingestion worker HPA

The plan specifies a Kubernetes HPA on the `edgar_ingest` worker deployment, scaled on
`EDGAR_POLL` task queue depth. At 80% of the throttle threshold, a queue depth alert
fires. `MAX_WORKER_CONCURRENCY` is configurable via env. Because task claims use
`SELECT ... FOR UPDATE SKIP LOCKED`, N replicas can claim concurrently with zero duplicate
execution (WORKER-C-022). At MVP, EDGAR's 10-minute feed cadence produces low task
volumes; HPA scaling is primarily a guard for bursts (e.g., a large batch of SEC filings
in one feed refresh).

The enrichment and notification workers scale independently by their respective queue
depths. The scheduler worker is low-frequency and runs as a single replica at MVP.

### Error handling

- **Stale-claim recovery (TQ-D-003).** Tasks stuck in `claimed` status after `claim_expires_at`
  are reset to `pending` by a scheduled sweep. Attempts below `max_attempts` get exponential
  backoff (`2^attempt` seconds). At or above `max_attempts` the task transitions to `dead`.
- **Dead-letter queue.** `status = 'dead'` tasks remain in the queue for operator inspection.
  Alert fires when dead-task count per agent type exceeds `DLQ_ALERT_THRESHOLD = 10`.
- **Business-rule violations (HTTP 422).** These are terminal on first attempt; retry
  cannot fix a policy rejection.
- **Channel failures (notification worker).** Non-blocking per channel; each failure is
  an audit event; retry via DLQ with exponential backoff.

## Recommended technologies and vendors

One pick per slot, rationale given:

| Slot                                    | Pick                                                                                   | Rationale                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker process manager                  | **Kubernetes Deployment + native Bun daemon**                                          | The blueprint prescribes k3d/k8s from Phase 0 (`ENV-D-002`). pm2 adds a layer the blueprint does not need; Bun's native process lifecycle (exit on error, restart via k8s liveness probe) keeps the worker simple. Each agent type is a dedicated Deployment.                                        |
| Per-worker concurrency model            | **Single-threaded Bun event loop, claim-loop with `Promise.all` for concurrent tasks** | Bun's event loop handles multiple in-flight HTTP calls efficiently. For the enrichment worker, `max_tasks` on the claim endpoint allows claiming a batch; the worker processes them concurrently via `Promise.all`. No worker threads needed at MVP task volumes.                                    |
| Autoscaling signal (queue depth metric) | **Prometheus custom metric via `pg_query_exporter`**                                   | The task_queue table is already in PostgreSQL. `pg_query_exporter` (or `postgres_exporter` with a custom query) exposes `task_queue_pending_total{agent_type="edgar_ingest"}` as a Prometheus gauge. KEDA's `prometheus` trigger drives the HPA. This avoids a separate metrics store.               |
| Graceful-shutdown library               | **Node.js `process.on('SIGTERM')` with manual drain**                                  | Bun supports standard Node.js signal handling. On SIGTERM, the worker stops claiming new tasks and awaits completion of in-flight tasks up to a configurable drain timeout, then exits. No external library needed; the implementation is 20–30 lines in `runner.ts`.                                |
| Log/trace correlation                   | **OpenTelemetry SDK (`@opentelemetry/sdk-node`) with `trace_id` propagation**          | The plan requires trace-ID propagation from browser → server → DB (`DEPLOY-D-004`). OpenTelemetry is the vendor-neutral standard; the same SDK instruments the API server and workers. `trace_id` is injected into every structured log entry via the logging middleware, satisfying `DEPLOY-C-021`. |

## Gaps and conflicts

1. **PRD §9 "sub-second" obligation vs. enrichment pipeline depth.** The PRD mandates
   sub-second detection-to-notification. The enrichment pipeline involves terms extraction
   and delta-neutral calculation, which may take seconds on complex filings. The plan
   resolves this by splitting the delivery path: the WebSocket push fires on the
   `Deduplicated` state transition (driven by LISTEN/NOTIFY, not the notification worker's
   claim loop), while outbound channels (email, SMS, webhook) are dispatched
   asynchronously by the notification worker. The sub-second SLA applies to the WebSocket
   push, not the outbound channels. This resolution is implicit in the plan but not
   explicitly documented.

2. **Enrichment digital twin sandbox cost.** The plan requires enrichment workers to run
   against a sandboxed digital twin (`WORKER-D-006`, `WORKER-C-011/012`). Fast clone
   creation infrastructure is a non-trivial dependency. At MVP with EDGAR as the only
   source, the blast radius of a bad enrichment write is limited. Clarification is needed
   on whether the digital twin requirement applies to Phase 3 MVP or only to consequential
   business actions (e.g., trade submission in Phase 6).

3. **No worker-ts.yaml.** The TypeScript worker implementation is split across
   `task-queue-ts.yaml` and `process-ts.yaml`. There is no single normative document
   governing worker-specific TypeScript patterns (e.g., Bun.spawn array-form invocation,
   startup guard location, vendor CLI pinning). This creates a documentation gap that may
   result in implementation drift across worker types as the team scales.

4. **Notification worker delivery ordering.** The plan specifies that `Alert` transitions
   to `Delivered` only after all enabled channels confirm dispatch. If the email adapter
   is slow or flaky, it can delay the `Delivered` state transition for the WebSocket
   channel. The plan says channel failures are non-blocking, but the `Delivered` state
   gate on "all channels dispatched or failed" is potentially serializing. This needs
   clarification: either `Delivered` is set on WebSocket push (ignoring outbound channel
   completion), or a separate `OutboundDelivered` state is introduced.

5. **`ALERT_SUPPLEMENT` task type is not in the task type inventory.** The plan mentions
   `ALERT_SUPPLEMENT` tasks for post-`Delivered` amended filings, but the task type table
   in Phase 0 does not list it. This is a schema gap that must be resolved before Phase 3
   enrichment lands.

## Open questions

1. **Digital twin scope in Phase 3.** Does the enrichment digital twin sandbox requirement
   (`WORKER-D-006`) apply to all enrichment runs at MVP, or only to the consequential
   "promote to live alert" step? If all runs require a twin, the Phase 3 scout cannot land
   until twin orchestration infrastructure exists, which may push Phase 3 scope
   significantly.

2. **Notification worker `Delivered` state definition.** Should `Alert.Delivered` be set
   on WebSocket push completion (ignoring outbound channels), or on completion of all
   enabled outbound channels? The distinction affects both the state machine implementation
   and the latency SLA.

3. **`ALERT_SUPPLEMENT` task type.** Should `ALERT_SUPPLEMENT` be a distinct agent type
   or sub-routed through the `enrichment` agent type? If sub-routed, the task type table
   in Phase 0 needs to be extended before Phase 3 begins.

4. **Scheduler worker crash during date-window transitions.** If the scheduler worker
   crashes mid-advance (after claiming `CORP_ACTION_ADVANCE` but before submitting the
   result), stale-claim recovery will re-queue the task. The `PATCH /internal/corporate-actions/:id/advance`
   endpoint must be idempotent (same transition submitted twice must be a no-op or return
   200 without creating a duplicate journal entry). Is idempotency of state-machine advance
   endpoints currently specified?

5. **HPA metric latency.** `pg_query_exporter` scrape intervals are typically 15–30
   seconds, meaning the HPA may lag queue depth spikes by up to 30 seconds. For a 10-minute
   EDGAR feed cadence this is acceptable, but if v2 adds higher-frequency sources
   (Bloomberg real-time), the scaling signal may need to move to a lower-latency metric
   source. Is this acknowledged as a known v1 limitation?

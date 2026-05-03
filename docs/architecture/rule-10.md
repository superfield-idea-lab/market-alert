# Rule 10: task-queue — Durable Task Queue

---

## Summary of the blueprint rule

The task-queue blueprint (domain `TASK-QUEUE`, v1) defines the contract between the platform and its workers across six mandatory invariants:

1. **Atomic claim / exactly-one-winner** (TQ-P-001). Claims are arbitrated by PostgreSQL via `UPDATE … WHERE status = 'pending' RETURNING`; no application-level locking. Concurrent claimants receive exactly one winner and N-1 empty result sets.
2. **Opaque reference payloads** (TQ-P-002). Payloads carry only UUIDs, routing metadata, and action descriptors. No PII, no business content, no credentials. Workers fetch business data through authenticated API reads at execution time.
3. **Idempotent task creation** (TQ-P-003). Every task carries a caller-supplied `idempotency_key` with a UNIQUE database constraint. Duplicate creation requests return the existing task rather than inserting a second one.
4. **Bounded retry with dead-letter** (TQ-P-004). Failed tasks retry with exponential backoff up to a configurable `max_attempts`. Exhausted tasks transition to terminal `dead` status and remain visible for operator inspection; they are never silently deleted. Business-rule violations (HTTP 422) are terminal on the first attempt.
5. **Notification assists polling, not replaces it** (TQ-P-005). PostgreSQL `LISTEN/NOTIFY` reduces delivery latency but is a transport hint only. The API server's bounded poll loop is the authoritative discovery mechanism. Workers never hold a database connection — the API server fans notifications to workers over Server-Sent Events (SSE).
6. **Priority-ordered FIFO** (TQ-D-006). Tasks are ordered `priority ASC, created_at ASC`. Lower priority number = higher urgency. Within a priority band, oldest tasks are claimed first. Age-based escalation is deferred until starvation is observed in practice.

Additional invariants: stale-claim recovery (TQ-D-003) resets expired `claimed` tasks to `pending` or `dead` on a scheduled sweep; per-type filtered views (TQ-D-004) prevent sensitive columns from reaching workers; cron and hook dispatch (TQ-D-007/008) both funnel through the API server — no external trigger writes directly to the database.

The blueprint explicitly prohibits: polling without backoff (TQ-X-001), business data in payloads (TQ-X-002), unbounded retry (TQ-X-003), notification as the sole trigger (TQ-X-004), API server executing CPU-bound work inline (TQ-X-005), and workers holding any database connection (TQ-X-006).

---

## TypeScript implementation specifics

The TypeScript implementation (`task-queue-ts.yaml`) maps each blueprint rule to concrete Bun/PostgreSQL code:

| Blueprint rule         | TypeScript implementation                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ----------------------------------------------------------------------------------------------------------------------------- |
| TQ-P-001 atomic claim  | `POST /api/v1/tasks/claim` executes `UPDATE … FOR UPDATE SKIP LOCKED` in one atomic statement. Returns claimed rows including `delegated_token`. Service token `agent_type` must match requested type.                                                                                                                                                 |
| TQ-P-005 LISTEN/NOTIFY | API server maintains one persistent `pg` LISTEN connection per agent type (separate from the main pool), managed by `IMPL-TQ-TS-001`. On `pg_notify`, the in-process SSE fan-out registry (`Map<agent_type, Set<ReadableStreamController>>`) in `apps/server/src/task-queue/sse.ts` writes `data: task_available\n\n` to each connected worker stream. |
| TQ-P-005 poll fallback | A `setInterval` at `TASK_QUEUE_POLL_INTERVAL_MS` (default 5000 ms) unconditionally emits `data: heartbeat\n\n` to all connected SSE clients. Workers treat `heartbeat` identically to `task_available` and attempt a claim.                                                                                                                            |
| SSE endpoint           | `GET /api/v1/tasks/stream?token=<service_token>`. `EventSource` does not support custom headers, so the service token is a query parameter. A logging middleware rewrites the URL to `token=[REDACTED]` before any log write (`IMPL-TQ-TS-011`).                                                                                                       |
| Worker discovery       | Worker daemon connects via native Bun `EventSource`. No `DATABASE_URL` in the worker environment. Startup guard (`apps/worker/src/startup-guard.ts`) aborts with exit code 1 if any of `DATABASE_URL`, `PGPASSWORD`, `PGHOST`, `PGUSER`, `PGDATABASE` are present.                                                                                     |
| NOTIFY trigger         | `AFTER INSERT OR UPDATE` trigger calls `pg*notify('task_queue*'                                                                                                                                                                                                                                                                                        |     | NEW.agent_type, NEW.id::text)`whenever`NEW.status = 'pending'`. Fires on both new insertions and stale-claim recovery resets. |
| Kubernetes             | Each agent type gets a dedicated `Deployment`. Pod spec: one `Secret` for the per-type `SERVICE_TOKEN` only (no `DATABASE_URL`); `NetworkPolicy` blocks egress to port 5432.                                                                                                                                                                           |
| Worker DB import guard | CI verifies `apps/worker/package.json` has no `postgres`, `pg`, or similar client as a dependency (`IMPL-TQ-TS-X-001`).                                                                                                                                                                                                                                |

The claim SQL (from `IMPL-TQ-TS-006`) is:

```sql
UPDATE task_queue
SET status = 'claimed',
    claimed_by    = $worker_instance_id,
    claimed_at    = now(),
    claim_expires_at = now() + $CLAIM_TTL_SECONDS
WHERE id IN (
  SELECT id FROM task_queue
  WHERE status = 'pending' AND agent_type = $agent_type
  ORDER BY priority ASC, created_at ASC
  LIMIT $max_tasks
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

The `worker_instance_id` is a stable UUID generated at process startup (not per-claim), enabling stale-claim attribution in the audit log.

---

## Application to market-alert PRD/plan

### Task types

The plan introduces six task types in `packages/db/task-queue.ts` alongside the existing KB substrate types:

| TaskType constant     | `agent_type`   | Worker                                       | Trigger mechanism                               |
| --------------------- | -------------- | -------------------------------------------- | ----------------------------------------------- |
| `EDGAR_POLL`          | `edgar_ingest` | Ingestion worker                             | Cron every 10 min (pg_cron or K8s CronJob)      |
| `ALERT_ENRICH`        | `enrichment`   | Enrichment worker                            | Enqueued by `edgar_ingest` worker on new filing |
| `ALERT_DEDUP`         | `enrichment`   | Same enrichment worker, `job_type` sub-route | Enqueued after `ALERT_ENRICH` completes         |
| `ALERT_NOTIFY`        | `notification` | Notification worker                          | Enqueued on alert reaching `Deduplicated` state |
| `CORP_ACTION_ADVANCE` | `scheduler`    | Scheduler worker                             | Cron on `effective_date` / `settlement_date`    |
| `TRADE_SETTLE`        | `scheduler`    | Same scheduler worker, `job_type` sub-route  | Cron on settlement date                         |

### Guarantees required per task type

**`EDGAR_POLL` (ingestion poller)**

- Delivery: at-least-once. A missed poll window is recoverable on the next interval; a duplicate poll of the same window is safe because the `idempotency_key = 'edgar_poll:<form_type>:<accession_number>'` constraint at the filing level prevents duplicate `CorporateAction` rows.
- Ordering: unordered across form types. Each form type is an independent stream.
- Priority: normal (no urgency differential between form types in v1).
- Stale recovery: critical. A poll worker crash must not leave the 10-minute window uncovered. `claim_expires_at` set to slightly less than the poll interval (e.g., 8 min) ensures recovery before the next cron fires.
- Blueprint mapping: `EDGAR_POLL` idempotency key satisfies TQ-D-008 (cron-idempotency-key) — the accession number encodes the unique filing event, making re-fire safe.

**`ALERT_ENRICH` (enrichment)**

- Delivery: at-least-once. Terms extraction is idempotent against the same `corporate_action_id`; re-running enrichment on the same filing overwrites the same `Alert` row rather than creating a duplicate (idempotency key: `'alert_enrich:<corporate_action_id>'`).
- Ordering: within a single corporate action, enrichment must complete before dedup. This is enforced by the sequential enqueue chain (`ALERT_ENRICH` → on completion → `ALERT_DEDUP`), not by queue ordering.
- Priority: high (1) — enrichment latency directly affects the sub-second alert delivery SLA from PRD §9.
- Stale recovery: required. A crashed enrichment worker must not strand the alert in `Enriched` state indefinitely. `claim_expires_at` should be generous (e.g., 5 min) to accommodate slow terms extraction without false recovery.

**`ALERT_DEDUP` (deduplication)**

- Delivery: at-least-once. Dedup is idempotent: re-running against the same `(ticker, event_type, announced_at ± 24h)` key produces the same merge decision.
- Ordering: strictly after `ALERT_ENRICH` for the same corporate action. The enqueue chain enforces this.
- Priority: high (1) — same SLA chain as enrichment.
- Exactly-once concern: dedup merge decisions must be journaled transactionally to avoid double-merge on retry. The business journal entry is written in the same API call that updates alert state, satisfying this at the API layer.

**`ALERT_NOTIFY` (outbound delivery)**

- Delivery: at-least-once per enabled channel. The notification worker retries individual channel failures (email, SMS, webhook) via the DLQ path. Channel failures are non-blocking: a failed email does not block the WebSocket push.
- Ordering: no strict ordering requirement between traders. Per-trader, delivery order matches alert timestamp order (priority + `created_at` FIFO).
- Priority: high (1) for real-time channels; normal (2) for batch/email if differentiated in v2.
- Idempotency: `idempotency_key = 'alert_notify:<alert_id>:<trader_id>:<channel>'`. Prevents duplicate email/SMS on retry.

**`CORP_ACTION_ADVANCE` (state machine advancement)**

- Delivery: at-least-once. State machine transitions are idempotent: advancing an already-`Effective` corporate action to `Effective` is a no-op (checked in the API handler).
- Ordering: `Announced → Effective → Closed`. The cron fires on specific calendar dates; ordering is temporal, not queue-ordering.
- Priority: normal (2). State transitions are important but not latency-critical.
- Stale recovery: required. A missed `CORP_ACTION_ADVANCE` leaves the `CorporateAction` stuck in `Announced` past its effective date. `claim_expires_at` should be set to 30 min; a missed sweep fires a DLQ alert.

**`TRADE_SETTLE` (settlement tracking)**

- Delivery: exactly-once in effect (idempotent in implementation). Settlement is idempotent: marking an already-`Settled` trade `Settled` again is a no-op. The idempotency key `'trade_settle:<trade_id>'` prevents duplicate settlement rows.
- Ordering: must fire after `Executed` state is confirmed. Enforced by the state machine — the `TRADE_SETTLE` task is only enqueued when a trade reaches `Executed`.
- Priority: high (1) on settlement date. A late settlement impacts reconciliation accuracy.
- Stale recovery: critical. Settlement date is a hard business deadline.

### SKIP LOCKED + LISTEN/NOTIFY mapping

The `FOR UPDATE SKIP LOCKED` pattern directly maps to the market-alert workload:

- **Ingestion workers** (`edgar_ingest`): Multiple replicas can safely claim independent `EDGAR_POLL` tasks for different form types in the same poll window. SKIP LOCKED means replicas never contend on the same task row; each claims the next available form type.
- **Enrichment workers** (`enrichment`): `ALERT_ENRICH` and `ALERT_DEDUP` tasks share the same `agent_type`. The `job_type` column routes dispatch inside `runner.ts`. SKIP LOCKED prevents two enrichment replicas from claiming the same filing simultaneously.
- **Notification workers** (`notification`): `ALERT_NOTIFY` tasks are per-alert. SKIP LOCKED allows burst parallelism — multiple notification workers claim independent alerts without coordination.
- **Scheduler workers** (`scheduler`): Low-volume cron-driven tasks. SKIP LOCKED prevents duplicate `CORP_ACTION_ADVANCE` or `TRADE_SETTLE` execution even under HPA scale-out.
- **LISTEN/NOTIFY role**: The ingestion and enrichment pipelines have a sub-second delivery SLA (PRD §9). LISTEN/NOTIFY reduces the gap between `EDGAR_POLL` task completion (which enqueues `ALERT_ENRICH`) and the enrichment worker's next claim attempt, keeping the pipeline latency well below the 5-second poll fallback interval.

---

## Recommended technologies and vendors

**Queue backend: PostgreSQL (existing `mkt_app` pool)**
Confirmed. The blueprint mandates Postgres as the queue backend for systems at this task volume (tens to low hundreds per minute). EDGAR publishes ~500–2000 filings/day total; the plan estimates burst of 50 filings/minute — comfortably within PostgreSQL's claim throughput. No separate broker is introduced.

**Backpressure strategy: HPA on queue depth via custom metrics**
Pick: Kubernetes Horizontal Pod Autoscaler driven by a custom metric exported from the API server. The API server exposes `task_queue_pending_total{agent_type}` as a Prometheus gauge. Prometheus Adapter maps this to a `custom.metrics.k8s.io` resource. Each worker `Deployment` scales when pending task count exceeds a per-type threshold (e.g., `edgar_ingest`: scale at 5 pending, `enrichment`: scale at 10 pending). This keeps queue depth bounded without overprovisioning idle replicas. The API server's SSE heartbeat ensures newly scaled workers begin claiming immediately without waiting a full poll interval.

**Queue depth observability: Grafana Cloud with Prometheus remote-write**
Pick: Grafana Cloud (free tier sufficient for v1 alert volumes). The API server emits the following Prometheus metrics:

- `task_queue_pending_total{agent_type, job_type}` — pending task count
- `task_queue_claimed_total{agent_type}` — in-flight tasks
- `task_queue_dead_total{agent_type, job_type}` — DLQ depth (alert threshold already defined as `DLQ_ALERT_THRESHOLD = 10` in the plan)
- `task_queue_claim_latency_seconds{agent_type}` — time from `pending` insert to `claimed`
- `task_queue_e2e_latency_seconds{agent_type}` — time from `pending` to `completed`

A single Grafana dashboard panel per agent type shows queue depth over time with a red threshold line at the DLQ alert boundary. Grafana alerting fires a PagerDuty/Slack notification when `task_queue_dead_total` exceeds threshold for any `agent_type`. No additional vendor required beyond Prometheus (already assumed for HPA custom metrics).

**DLQ replay UI: admin panel dead-letter table (built-in, no third-party vendor)**
Pick: a table in the Phase 5 Admin panel (`/admin/dlq`) that queries `SELECT * FROM task_queue WHERE status = 'dead' ORDER BY updated_at DESC`. Each row shows `agent_type`, `job_type`, `idempotency_key`, `attempt`, `max_attempts`, `error_message`, `payload`, and `updated_at`. A "Requeue" button calls a new internal endpoint `POST /internal/tasks/:id/requeue` that resets `status = 'pending'`, increments `max_attempts`, and clears `error_message`. The requeue action is an audit event. This keeps the DLQ inspection and replay path entirely within the existing admin surface without introducing a separate queue management tool (no Retool, no Temporal UI). All audit and RLS requirements already in place from Phase 1 apply to the DLQ table automatically.

**Scheduled-task layer (cron triggers): application-level cron using `node-cron` inside the API server**
Pick: application-level cron (`node-cron`) running inside the API server process, calling the API server's own `POST /internal/tasks` endpoint to create task rows. Rationale: `pg_cron` requires a dedicated PostgreSQL extension and superuser-equivalent access to install, which conflicts with the four-pool role isolation model (`DATA-D-006`). K8s CronJobs add deployment complexity and a network hop before any market data is landing. `node-cron` runs in-process, respects the `feature_flags` table gate before inserting (e.g., `edgar_ingest` flag must be `true`), and uses the cron-idempotency-key pattern (TQ-D-008) — `'edgar_poll:<form_type>:<window>'` — so clock drift or API server restart cannot produce duplicates. The poll interval is configurable via `feature_flags` table rows, not a hard-coded constant (satisfying `PRUNE-A-003`). If the API server restarts mid-interval, the cron re-fires at the next tick; the idempotency key absorbs the duplicate.

---

## Gaps and conflicts

**Gap 1 — `SKIP LOCKED` and `FOR UPDATE` semantics not enforced at the schema level**
The plan states that `packages/db/task-queue.ts` already implements `claimNextTask` with `FOR UPDATE SKIP LOCKED`, but the blueprint checklist TQ-C-001 requires concurrent claim to be tested under load with multiple replicas. The plan does not include a load test or concurrency test for the trading task types. The existing test coverage for the KB substrate types does not automatically cover the new `EDGAR_POLL`, `ALERT_ENRICH`, etc. entries. A dedicated integration test asserting claim atomicity for each new `agent_type` must be added before Phase 2 exits.

**Gap 2 — No per-task-type `claim_expires_at` configuration**
The blueprint's stale-claim recovery (TQ-D-003) uses a single `CLAIM_TTL_SECONDS` constant. The trading task types have materially different execution durations: `EDGAR_POLL` (network I/O, ~30 s), `ALERT_ENRICH` (text parsing, potentially 2–5 min for large S-4 filings), `TRADE_SETTLE` (single API call, ~5 s). A single TTL will either cause false stale-recovery on slow enrichment tasks or leave failed fast tasks locked for too long. The `task_queue` schema should support a per-row `claim_expires_at` set at claim time based on the `job_type`, not a global constant.

**Gap 3 — `ALERT_DEDUP` merge decisions require transactional journal write**
The deduplication engine merges two enriched alerts into one by writing to the business journal. If the `ALERT_DEDUP` task is retried (stale claim or transient failure), the merge could run twice before the first journal write commits. The API handler for `POST /internal/alerts/:id/dedup` must wrap the dedup decision and journal entry in a single database transaction with a check-and-set on `Alert.status` to prevent double-merge. This is an API-layer concern, not a queue-layer concern, but it is surfaced by the at-least-once delivery guarantee of the queue.

**Gap 4 — `ALERT_NOTIFY` channel-level retry is not a separate task type**
The plan routes outbound channel failures through the DLQ with exponential backoff, but uses the same `ALERT_NOTIFY` task for all channels. If email delivery fails and SMS succeeds, re-queuing the `ALERT_NOTIFY` task will re-attempt both channels unless the worker tracks per-channel completion state in the task result. Either the `ALERT_NOTIFY` task must track per-channel status in its `result` JSONB (and workers skip already-confirmed channels on retry), or separate `ALERT_NOTIFY_EMAIL`, `ALERT_NOTIFY_SMS`, `ALERT_NOTIFY_WEBHOOK` task types should be used. The current plan is ambiguous on this.

**Gap 5 — No plan for stale-claim recovery notification on trading task types**
The blueprint requires that stale-claim recovery fires a `pg_notify` (via the AFTER UPDATE trigger) to wake workers when a task is reset to `pending`. The plan's existing trigger (`IMPL-TQ-TS-009`) fires on `NEW.status = 'pending'`, which covers both INSERT and UPDATE. This is correct. However, the plan does not include a checklist item (TQ-C-002 equivalent) for trading task types verifying that a crashed enrichment or notification worker's task returns to `pending` and is claimed by a new replica. This test must be added.

**Conflict — Sub-second SLA vs. 5-second poll fallback interval**
The PRD mandates sub-second latency from event detection to trader notification (§9). The enrichment pipeline spans at minimum: `EDGAR_POLL` completion → `ALERT_ENRICH` enqueue → notify → claim → execute → `ALERT_DEDUP` enqueue → claim → execute → `ALERT_NOTIFY` enqueue → claim → execute → WebSocket push. Each transition from completion to next claim can be up to 5 seconds (the `TASK_QUEUE_POLL_INTERVAL_MS` fallback). With LISTEN/NOTIFY operating correctly, the claim latency is near-zero. But the sub-second SLA is incompatible with a pipeline that has four queue hops if any LISTEN/NOTIFY notification is missed. The SLA must be re-read as "sub-second from enriched alert to trader WebSocket receipt" (the Phase 4 scout definition), not "sub-second from EDGAR filing to delivery." The architecture document should note this scope clarification explicitly. The EDGAR feed itself refreshes every 10 minutes, so the overall ingestion-to-delivery latency is bounded by the poll interval, not the queue hop latency.

---

## Open questions

1. **Per-task-type `claim_expires_at`**: Should `claimNextTask` accept a per-call TTL override, or should the `task_queue` schema store a `claim_ttl_seconds` column set at enqueue time by the producer? The latter is cleaner for observability but requires a schema addition.

2. **`ALERT_NOTIFY` channel granularity**: Should each outbound channel (email, SMS, webhook) be a separate task type with its own idempotency key and DLQ entry, or should channel state be tracked inside a single `ALERT_NOTIFY` task's `result` JSONB? The separate-task model is cleaner for retry isolation; the single-task model is simpler to implement.

3. **Enrichment task timeout for large S-4 filings**: S-4 merger registration statements can exceed 200 pages of structured HTML. What is the maximum acceptable enrichment duration before stale-claim recovery fires? This determines the `claim_expires_at` for `ALERT_ENRICH` tasks and whether an intermediate "still running" heartbeat mechanism is needed.

4. **`node-cron` single-process limitation**: Application-level cron running inside the API server is a single point of scheduling failure if the API server has multiple replicas. Each replica would fire its own cron tick, producing duplicate task-creation attempts (mitigated by the idempotency key, but wasteful). Should the cron be run only in one designated "leader" API server replica (via a leader-election pattern), or is idempotency-key deduplication sufficient at this scale?

5. **`ALERT_SUPPLEMENT` task type for post-delivery amended filings**: The plan defines an `ALERT_SUPPLEMENT` flow for amended filings that arrive after an alert reaches `Delivered`. This task type is not listed in the `TaskType` / `TASK_TYPE_AGENT_MAP` extension table. Does it share the `enrichment` agent type, and what is its idempotency key format? This must be resolved before Phase 3 follow-on issues are estimated.

6. **DLQ threshold per task type**: The plan carries a single `DLQ_ALERT_THRESHOLD = 10` for all agent types. Some task types (e.g., `ALERT_NOTIFY` for SMS) may have higher transient failure rates than others (e.g., `CORP_ACTION_ADVANCE`). Should the threshold be per-`(agent_type, job_type)` pair, configurable in the `feature_flags` table?

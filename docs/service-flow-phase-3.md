# Service Flow Map — Phase 3: Alert Enrichment Pipeline

<!-- Phase: 3 — Alert Enrichment Pipeline -->
<!-- Canonical docs: docs/plan.md § Phase 3 -->

## Overview

Phase 3 enriches raw CorporateAction entities: extracts structured trade terms from SEC
filing text, deduplicates across sources, and produces a ready-to-deliver Alert entity.
All writes go through the API (worker has no DB credentials).

---

## Enrichment pipeline end-to-end

```
task_queue (ALERT_ENRICH)       apps/worker                   apps/server
        |                       enrichment-job.ts                    |
        |<-- claimNextTask() ---|                                    |
        |    agent_type=enrichment                                   |
        |                       |                                    |
        |                       |-- GET /internal/corporate-action/:id
        |                       |<-- CorporateAction (encrypted) ---|
        |                       |                                    |
        |                       | decrypt filing text                |
        |                       | extract trade terms (LLM / regex)  |
        |                       | normalise entity fields            |
        |                       |                                    |
        |                       |-- POST /internal/alerts/enrich    |
        |                       |   (enriched terms payload)         |
        |                       |<-- 200 OK + alert_id -------------|
        |                       |                                    |
        |                       | enqueue ALERT_DEDUP (same worker) |
        |                       |                                    |
        |-- task completed ----> |                                    |
```

---

## Deduplication flow (ALERT_DEDUP)

```
task_queue (ALERT_DEDUP)        apps/worker               Postgres (mkt_app)
        |                       enrichment-job.ts                |
        |<-- claimNextTask() ---|                                |
        |    agent_type=enrichment                               |
        |    job_type=dedup                                      |
        |                       |                                |
        |                       |-- POST /internal/alerts/dedup |
        |                       |   (alert_id + fingerprint)     |
        |                       |                                |
        |                       apps/server                      |
        |                       |-- SELECT matching fingerprint ->|
        |                       |   [if match: mark duplicate]   |
        |                       |   [if no match: mark unique]   |
        |                       |-- INSERT audit_event --------> | (mkt_audit)
        |                       |-- enqueue ALERT_NOTIFY ------> task_queue
        |                       |<-- 200 OK -------------------- |
        |-- task completed ----> |                                |
```

---

## Alert entity state machine

```
Raw → Enriching → Enriched → Deduplicating → Deduplicated → Delivering → Delivered
                                          → Duplicate (suppressed, not delivered)
```

---

## Fingerprint scheme

Alert deduplication fingerprint is a deterministic hash over:

- `corp_action_id` (source entity)
- `event_type` (M&A, dividend, spinoff, etc.)
- `ticker` (primary symbol)
- `effective_date` (normalised ISO date)

Same fingerprint within a 24-hour window → duplicate; suppress delivery.

---

## Worker credential model (same as Phase 2)

- Worker has no direct DB credentials.
- All reads: `GET /internal/...` with delegated token.
- All writes: `POST /internal/...` with delegated token.
- Token scope: `agent_type=enrichment` only.

---

## Exit criteria

- One end-to-end run: raw CorporateAction → enriched Alert → deduplicated → ALERT_NOTIFY
  task enqueued.
- Duplicate filing produces a Duplicate alert (not a second ALERT_NOTIFY task).
- All filing text and enriched fields stored encrypted at rest.

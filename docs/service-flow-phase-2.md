# Service Flow Map — Phase 2: EDGAR Ingestion Worker

<!-- Phase: 2 — EDGAR Ingestion Worker -->
<!-- Canonical docs: docs/plan.md § Phase 2 -->

## Overview

Phase 2 ingests SEC filings from the EDGAR RSS/ATOM feed (free, public, authoritative).
One real filing lands as a stored `CorporateAction` entity, queued for enrichment.
EDGAR is the sole v1 data source; commercial vendor adapters are deferred to v2.

---

## End-to-end ingestion flow

```
Postgres (mkt_app)          apps/worker                 EDGAR RSS feed
task_queue                  edgar-ingest-job.ts          sec.gov/cgi-bin/...
     |                            |                            |
     | (cron inserts EDGAR_POLL)  |                            |
     |-- INSERT task_queue row -> |                            |
     |                            |                            |
     |<-- claimNextTask() --------|                            |
     |    agent_type=edgar_ingest |                            |
     |                            |-- GET ATOM feed ---------> |
     |                            |<-- XML/ATOM response -----|
     |                            |   (MSW v2 fixture in CI)  |
     |                            |                            |
     |                            | parse entries,             |
     |                            | dedup by accession_number  |
     |                            |                            |
     |                            |-- POST /internal/ingestion/corporate-action
     |                            |   (normalised entity)      |
     |                            |                            |
     |                            apps/server                  |
     |                            |-- validate payload         |
     |                            |-- INSERT CorporateAction ->|
     |                            |-- INSERT audit_event ------>| (mkt_audit)
     |                            |-- enqueue ALERT_ENRICH ---> task_queue
     |                            |                            |
     |                            |-- POST /api/tasks/:id/result
     |                            |   (submitResultViaApi)     |
     |<-- task status=completed --|                            |
```

---

## Idempotency key scheme

```
EDGAR_POLL idempotency_key: "edgar_poll:<form_type>:<accession_number>"

Example:
  form_type = "8-K"
  accession_number = "0001234567-24-000001"
  key = "edgar_poll:8-K:0001234567-24-000001"
```

Duplicate key on INSERT → task silently skipped (no duplicate CorporateAction).

---

## Worker credential model

```
apps/worker                 apps/server (auth middleware)
    |                                |
    |-- POST /internal/ingestion/    |
    |   Authorization: Bearer <delegated_token>
    |                                |
    |                                |-- verify token (short-lived, scoped)
    |                                |-- authorize agent_type=edgar_ingest
    |<-- 200 OK or 422 error --------|
```

Worker has no direct DB credentials. All writes route through the internal API.

---

## Task queue state machine (existing)

```
pending → claimed → running → submitting → completed
                                         → failed (retry if attempt < max_attempts)
                                         → dead (DLQ if attempt ≥ max_attempts)
claimed → pending  (stale recovery, backoff 2^attempt seconds)
claimed → dead     (stale recovery, attempt ≥ max_attempts)
```

DLQ alert threshold: 10 dead tasks per agent_type.

---

## EDGAR form types in scope (v1)

| Form     | Event type                |
| -------- | ------------------------- |
| 8-K      | Material corporate events |
| SC 13D/G | Beneficial ownership ≥ 5% |
| S-4      | Merger registration       |
| 425      | Merger communications     |
| DEF 14A  | Proxy / merger proxy      |

---

## Exit criteria

- Cron inserts one `EDGAR_POLL` task; worker claims and processes it.
- One CorporateAction row stored with filing text encrypted at rest.
- One `ALERT_ENRICH` task enqueued in response.
- MSW v2 fixture in `tests/fixtures/vendor/edgar/` covers the ATOM feed response.

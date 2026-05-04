# Service Flow Map — Phase 5: Admin Panel & Source Configuration

<!-- Phase: 5 — Admin panel & source configuration -->
<!-- Canonical docs: docs/plan.md § Phase 5 -->

## Overview

Phase 5 gives Admins the ability to toggle vendor source ingestion on/off, override
false-positive alerts, view per-source health metrics, and read the audit trail. All
configuration changes are backed by `feature_flags` table rows and journaled for
compliance. Phase 5 gates on Phase 1 (security foundation) and Phase 4 (alert delivery).

---

## Source toggle flow

```
Browser (Admin)               apps/server (admin API)        Postgres (mkt_app)
     |                               |                               |
     |-- PATCH /api/admin/sources/edgar   |                         |
     |   { enabled: false }          |                               |
     |                               |-- RLS: verify Admin role -----|
     |                               |-- UPDATE feature_flags ------>|
     |                               |   SET value='false'           |
     |                               |   WHERE key='edgar_ingest'    |
     |                               |-- INSERT business_journal --->|
     |                               |   { actor, action: 'source_disabled', target: 'edgar' }
     |<-- 200 { source, enabled } ---|
```

The EDGAR ingestion cron producer reads `feature_flags.edgar_ingest` before inserting
`EDGAR_POLL` tasks. When the flag is `false`, the cron skips insertion entirely.

---

## Alert override / suppression flow

```
Browser (Admin)               apps/server              Postgres (mkt_app)
     |                               |                        |
     |-- POST /api/admin/alerts/:id/suppress                  |
     |   { reason, suppress_pattern }|                        |
     |                               |-- RLS: Admin check ----|
     |                               |-- UPDATE alerts ------>|
     |                               |   SET state='suppressed', suppression_reason=...
     |                               |-- INSERT suppression_rules (if suppress_pattern)
     |                               |-- INSERT business_journal
     |<-- 200 { alert, state } ------|
```

Suppressed alerts are excluded from trader delivery. Future alerts matching
`(ticker, event_type)` are auto-suppressed if a suppression rule exists.

---

## Health metrics flow

```
Browser (Admin)            apps/server              Postgres (mkt_analytics)
     |                          |                          |
     |-- GET /api/admin/health/sources                     |
     |                          |                          |
     |                          |-- SELECT from mkt_analytics (NOT mkt_app)
     |                          |   task_queue_view_edgar_ingest
     |                          |   source_health_summary
     |                          |                          |
     |<-- 200 { sources: [      |                          |
     |   { name, enabled,       |                          |
     |     last_success,        |                          |
     |     last_failure,        |                          |
     |     circuit_breaker,     |                          |
     |     queue_depth }        |                          |
     | ]}                       |                          |
```

All health queries target `mkt_analytics`, not `mkt_app`, per `DATA-X-003`.

---

## Audit trail view

```
Browser (Admin)            apps/server              Postgres (mkt_audit)
     |                          |                          |
     |-- GET /api/admin/audit?page=1&limit=50              |
     |                          |                          |
     |                          |-- SELECT from mkt_audit.audit_events
     |                          |   ORDER BY created_at DESC
     |                          |   (read-only role, append-only store)
     |                          |                          |
     |<-- 200 { events, total } |                          |
     |                          |                          |
     |-- GET /api/admin/audit/export?from=...&to=...       |
     |                          |-- INSERT audit_events (export is itself an audit event)
     |                          |-- stream CSV response    |
```

---

## Admin dashboard shell — RLS enforcement

```
Browser (Admin)                    Postgres (mkt_app RLS)
     |                                    |
     |-- any /api/admin/* request ------> apps/server
     |                                    |-- RLS policy: require Admin role
     |                                    |-- reject non-Admin sessions with 403
```

Non-Admin sessions receive 403 at the database layer, not just the application layer.

---

## Alert volume / latency dashboards

```
Cron (every minute)      apps/worker (analytics-job.ts)    Postgres (mkt_analytics)
      |                          |                                  |
      |-- trigger metrics roll-up|                                  |
      |                          |-- aggregate from mkt_app ------->|
      |                          |   (pseudonymised, per-session    |
      |                          |    HMAC-SHA256 rotation)         |
      |                          |-- INSERT into mkt_analytics ----->|
      |                          |   alert_volume_by_source         |
      |                          |   delivery_latency_p50_p95       |
```

---

## Key modules

| Module           | Path                                   | Responsibility                     |
| ---------------- | -------------------------------------- | ---------------------------------- |
| Admin source API | `apps/server/src/api/admin/sources.ts` | PATCH toggle, GET health           |
| Admin alert API  | `apps/server/src/api/admin/alerts.ts`  | Suppress, override                 |
| Admin audit API  | `apps/server/src/api/admin/audit.ts`   | Paginated trail, CSV export        |
| Admin dashboard  | `apps/admin/src/pages/dashboard.tsx`   | Source config, health, audit       |
| Analytics worker | `apps/worker/src/analytics-job.ts`     | Metric roll-ups into mkt_analytics |

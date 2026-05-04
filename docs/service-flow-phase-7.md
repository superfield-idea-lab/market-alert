# Service Flow Map — Phase 7: Event Streaming & Replay

<!-- Phase: 7 — Event streaming & replay -->
<!-- Canonical docs: docs/plan.md § Phase 7 -->

## Overview

Phase 7 provides event replay from the business journal and audit log, enabling
point-in-time state reconstruction for any corporate action or trade. It also
populates the analytics tier with pseudonymised session data and materialised metrics.
Phase 7 gates on Phase 1 (audit store isolation).

---

## Corporate action replay flow

```
Browser (Admin/Trader)          apps/server              Postgres (mkt_audit / mkt_app)
     |                               |                          |
     |-- GET /api/replay/corporate-actions/:id                  |
     |                               |-- RLS: authenticated ----|
     |                               |-- SELECT business_journal|
     |                               |   WHERE entity_id = :id  |
     |                               |   ORDER BY seq ASC       |
     |<-- 200 { entries: [           |                          |
     |   { seq, actor, action,       |                          |
     |     timestamp, state_before,  |                          |
     |     state_after, input_hash } |                          |
     | ]}                            |                          |
```

The response is the ordered journal sequence that produced the current `CorporateAction`
entity state. Callers can reconstruct any intermediate state by replaying up to a given
sequence number.

---

## Point-in-time state query

```
Browser (Admin)              apps/server
     |                            |
     |-- GET /api/replay/corporate-actions/:id?at=2026-03-15T10:00:00Z
     |                            |
     |                            |-- SELECT business_journal
     |                            |   WHERE entity_id = :id
     |                            |     AND created_at <= :at
     |                            |   ORDER BY seq ASC
     |                            |-- materialise state from entries
     |<-- 200 { state_at_point_in_time }
```

---

## Live event stream (server-sent events)

```
Browser (Admin)              apps/server (sse-handler.ts)    Postgres LISTEN/NOTIFY
     |                               |                              |
     |-- GET /api/replay/stream/:entity_id   |                     |
     |   Accept: text/event-stream   |                             |
     |                               |-- subscribe to pg channel --|
     |                               |   business_journal_<entity_id>
     |                               |                              |
     |<-- SSE: { event, data } ------|<-- pg_notify -------------- |
     |   (each new journal entry)    |                             |
```

Same RLS rules as the read endpoint. Connection is closed when the entity reaches a
terminal state (`Reconciled`, `Deduplicated`) or on client disconnect.

---

## Replay export flow

```
Browser (Admin)              apps/server              Postgres (mkt_audit / mkt_app)
     |                            |                          |
     |-- POST /api/replay/export  |                          |
     |   { entity_type, entity_id,|                          |
     |     date_range, trader_id }|                          |
     |                            |-- INSERT audit_events ---|
     |                            |   { actor, action: 'export', params }
     |                            |-- SELECT journal + audit + snapshot
     |                            |-- verify against mkt_analytics materialisation
     |<-- 200 { download_url } ---|
     |                            |-- stream structured JSON bundle
```

The export bundle contains: journal entries, audit trail, entity snapshots.
The export is verified by comparing the materialised `mkt_analytics` count against
the live `mkt_app` state before streaming.

---

## Analytics tier population

```
Cron (every minute)     apps/worker (analytics-job.ts)     Postgres
     |                          |                    mkt_app | mkt_analytics
     |-- trigger analytics roll-up                           |
     |                          |                            |
     |                          |-- SELECT session events ---| (mkt_app)
     |                          |   pseudonymise:             |
     |                          |   HMAC-SHA256(session_id,  |
     |                          |               rotation_key) |
     |                          |-- aggregate alert/trade    |
     |                          |   metrics                  |
     |                          |-- INSERT into mkt_analytics|
     |                          |   alert_volume_by_source   |
     |                          |   delivery_latency_p50_p95 |
     |                          |   trade_state_counts       |
```

Session pseudonyms rotate per session via HMAC-SHA256. BDM-style queries execute
against `mkt_analytics`, never directly against `mkt_app` (`DATA-X-003`).

---

## 30-day fixture refresh

```
CI (scheduled, every 30 days)    golden-fixture-recorder.ts    EDGAR (sec.gov)
     |                                    |                          |
     |-- trigger fixture refresh -------->|                          |
     |                                    |-- record real HTTP ------>|
     |                                    |   request/response pairs  |
     |                                    |<-- response + schema -----|
     |                                    |-- compare against stored  |
     |                                    |   fixture schema          |
     |                                    |-- alert on schema drift   |
     |                                    |-- write to tests/fixtures/vendor/
     |<-- CI result: pass/fail with drift summary
```

---

## Key modules

| Module           | Path                                   | Responsibility                           |
| ---------------- | -------------------------------------- | ---------------------------------------- |
| Replay API       | `apps/server/src/api/replay.ts`        | Journal query, point-in-time, SSE stream |
| Export handler   | `apps/server/src/api/replay-export.ts` | Structured JSON bundle export            |
| Analytics worker | `apps/worker/src/analytics-job.ts`     | mkt_analytics roll-up, pseudonymisation  |
| Fixture recorder | `scripts/record-fixture.ts`            | 30-day vendor fixture refresh            |
| Business journal | `packages/db/src/business-journal.ts`  | Append-only journal store                |

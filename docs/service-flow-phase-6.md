# Service Flow Map — Phase 6: Trade Lifecycle Tracking

<!-- Phase: 6 — Trade lifecycle tracking -->
<!-- Canonical docs: docs/plan.md § Phase 6 -->

## Overview

Phase 6 lets Traders record proposed trades linked to alerts and advance them through
a full `Proposed → Executed → Settled → Reconciled` lifecycle. When the Phase 6 scout
merges, the `trade_lifecycle` feature flag flips to `true`, activating the previously
stubbed Phase 4 "Propose trade" CTA. Phase 6 gates on Phase 4 (alert delivery).

---

## Trade proposal flow (from Phase 4 CTA)

```
Browser (Trader)            apps/server              Postgres (mkt_app)
     |                           |                          |
     |-- POST /api/trades -----> |                          |
     |   { alert_id,             |                          |
     |     ticker,               |-- RLS: verify Trader ----|
     |     direction,            |-- INSERT trades -------->|
     |     notional }            |   state='Proposed'       |
     |                           |   encrypted: notional,   |
     |                           |              executed_price
     |                           |-- INSERT business_journal|
     |                           |   { actor, action: 'trade_proposed', trade_id }
     |<-- 201 { trade } ---------|
```

The Phase 4 feature flag `trade_lifecycle` must be `true` for this endpoint to accept
requests. The scout for Phase 6 flips the flag as its first migration step.

---

## Trade state machine

```
Proposed ──(PATCH /api/trades/:id, { state: 'Executed' })──> Executed
Executed ──(TRADE_SETTLE task, auto on settlement_date)─────> Settled
Settled  ──(PATCH /api/trades/:id, { state: 'Reconciled', reconciliation_notes })──> Reconciled

From any post-Executed state:
* ──(Admin PATCH, { state: 'Disputed', reason })──> Disputed
Disputed ──(Admin PATCH, { state: 'Reconciled' })──> Reconciled
```

Every state transition is a business journal entry. `Disputed` requires a compensation
event in the journal and an Admin-only PATCH endpoint.

---

## Settlement tracking flow

```
Cron (daily)           apps/worker (scheduler-job.ts)    Postgres (mkt_app)
     |                          |                               |
     |-- insert TRADE_SETTLE -->|                               |
     |   for trades where       |                               |
     |   settlement_date = today|                               |
     |                          |<-- claimTask() ---------------|
     |                          |                               |
     |                          |-- POST /internal/trades/:id/settle
     |                          |   (worker has no DB credentials)
     |                          |               |
     |                          |           apps/server
     |                          |               |-- UPDATE trades state→Settled
     |                          |               |-- INSERT business_journal
```

---

## RLS enforcement

```
Trader A session                  Postgres (mkt_app RLS)
     |                                    |
     |-- GET /api/trades ──────────────── |
     |                                    |-- RLS: filter WHERE trader_id = current_trader
     |<-- only Trader A's trades ─────── |

Trader B session
     |-- GET /api/trades/:trade_id_from_A |
     |                                    |-- RLS blocks: 404 (not 403 — no disclosure)
```

---

## Reconciliation flow

```
Browser (Trader)           apps/server              Postgres (mkt_app)
     |                          |                          |
     |-- PATCH /api/trades/:id -|                          |
     |   { state: 'Reconciled', |                          |
     |     reconciliation_notes }-- RLS: owning Trader ----|
     |                          |-- APPEND reconciliation -|
     |                          |   (append-only, no edits)|
     |                          |-- INSERT business_journal|
     |<-- 200 { trade } --------|
```

Reconciliation records are append-only. Subsequent calls add new notes; they do not
overwrite previous ones.

---

## Admin trade oversight flow

```
Browser (Admin)            apps/server              Postgres (mkt_app)
     |                          |                          |
     |-- GET /api/admin/trades --|                         |
     |                          |-- RLS: Admin sees all    |
     |                          |-- SELECT aggregate view  |
     |<-- 200 { trades[] } -----|   (no per-trader detail) |
     |                          |                          |
     |-- PATCH /api/admin/trades/:id                       |
     |   { state: 'Disputed', reason }                     |
     |                          |-- INSERT business_journal (compensation event)
     |                          |-- pg_notify ─────────────────> Trader WebSocket
     |<-- 200 { trade } --------|
```

---

## Key modules

| Module           | Path                                   | Responsibility                    |
| ---------------- | -------------------------------------- | --------------------------------- |
| Trade API        | `apps/server/src/api/trades.ts`        | CRUD, state machine transitions   |
| Admin trade API  | `apps/server/src/api/admin/trades.ts`  | Aggregate view, Disputed override |
| Scheduler worker | `apps/worker/src/scheduler-job.ts`     | TRADE_SETTLE auto-advance         |
| Trade form       | `apps/web/src/pages/trade-form.tsx`    | Propose trade from alert CTA      |
| Trade history    | `apps/web/src/pages/trade-history.tsx` | State timeline, journal entries   |

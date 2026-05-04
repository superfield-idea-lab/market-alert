# Service Flow Map — Phase 4: Real-time Alert Delivery & Trader UI

<!-- Phase: 4 — Real-time alert delivery & trader UI -->
<!-- Canonical docs: docs/plan.md § Phase 4 -->

## Overview

Phase 4 delivers enriched alerts to authenticated traders in under 1 second via a
LISTEN/NOTIFY-triggered WebSocket push. The trader UI renders the alert feed, supports
acknowledge action, and provides a stubbed "Propose trade" CTA (activated when Phase 6
merges). Outbound channels (email, SMS, webhook) dispatch via the `ALERT_NOTIFY` task.

---

## End-to-end alert delivery flow

```
task_queue (ALERT_DEDUP)    apps/worker              apps/server           Postgres (mkt_app)
        |                   dedup-job.ts              ws-server.ts                |
        |<-- claimTask() ---|                               |                    |
        |    agent=enrichment                               |                    |
        |                   |                               |                    |
        |-- markRunning() -->|                              |                    |
        |                   |                               |                    |
        |                   |-- POST /internal/alerts/dedup |                    |
        |                   |   { corporate_action_id }     |                    |
        |                   |                               |-- UPDATE alerts ------>
        |                   |                               |   state→Deduplicated|
        |                   |                               |-- pg_notify ---------> task_queue_notification
        |                   |                               |                    |
        |                   |                               |<-- LISTEN ----------|
        |                   |                               |   (ws-server listens on task_queue_notification)
        |                   |                               |
        |                   |                               |-- push to all connected Trader WebSocket sessions
        |                   |                               |   (watchlist-filtered)
        |                   |                               |
        |-- markComplete() ->|                              |
```

---

## WebSocket session lifecycle

```
Browser (Trader)                    apps/server (ws-server.ts)
     |                                        |
     |-- GET /ws (Upgrade: websocket) ------> |
     |   Cookie: session=<token>              |-- validate session (same as HTTP cookie auth)
     |                                        |-- reject with 401 if invalid
     |<-- 101 Switching Protocols ----------- |
     |                                        |-- subscribe trader to watchlist channels
     |                                        |
     |<-- { type: "alert", payload: {...} } -- |   (on pg_notify for ticker in trader watchlist)
     |                                        |
     |-- { type: "ping" } -----------------> |   (heartbeat every 30s)
     |<-- { type: "pong" } ---------------- |
     |                                        |
     |   (on network drop)                    |
     |-- reconnect with exponential backoff ->|
```

---

## Alert state machine (relevant transitions)

```
Enriched ──────────────────────────────────────────────────────> Deduplicated
Deduplicated ──(pg_notify + ALERT_NOTIFY enqueue)──────────────> Delivered
Delivered ──(POST /api/alerts/:id/acknowledge)──────────────────> Acknowledged
```

---

## Outbound notification dispatch (ALERT_NOTIFY task)

```
task_queue (ALERT_NOTIFY)    apps/worker (notification-job.ts)    External channels
        |                               |                               |
        |<-- claimTask() --------------|                               |
        |                               |                               |
        |                               |-- for each trader on watchlist:
        |                               |   check feature_flags:        |
        |                               |   - alert_notify_email → SMTP adapter ──> email
        |                               |   - alert_notify_sms   → SMS adapter ──> SMS
        |                               |   - alert_notify_webhook → HMAC-signed POST ──> webhook
        |                               |                               |
        |                               |-- POST /internal/alerts/:id/delivery-status
        |                               |   { channel, status, trader_id }
        |                               |                               |
        |-- markComplete() -------------|
```

Channel failures are non-blocking: a failed email does not block the WebSocket push.
Each channel failure writes an audit event. Retry via DLQ with exponential backoff.

---

## Trade proposal stub (Phase 4 CTA)

The alert detail view includes a "Propose trade" button that is **disabled** until the
`trade_lifecycle` feature flag flips to `true` (which happens when Phase 6 scout merges).

```
Alert detail view
  [Propose trade] ← disabled, gated by feature_flags.trade_lifecycle === false
```

When Phase 6 activates the flag, the button navigates to the Phase 6 trade form
pre-populated with `alert_id`, `ticker`, and inferred `direction`.

---

## RLS enforcement

```
Trader A session                  Postgres (mkt_app RLS)
     |                                    |
     |-- SELECT * FROM alerts WHERE ...-->|
     |                                    |-- RLS policy: filter by trader watchlist
     |<-- rows (only Trader A's tickers) -|
```

A second trader session cannot read alerts for tickers not on their watchlist.
Phase 4 Playwright e2e proves this at the DB layer.

---

## Key modules

| Module                | Path                                  | Responsibility                                   |
| --------------------- | ------------------------------------- | ------------------------------------------------ |
| WebSocket server      | `apps/server/src/ws/ws-server.ts`     | Upgrade, session auth, LISTEN/NOTIFY fan-out     |
| Notification worker   | `apps/worker/src/notification-job.ts` | Outbound channel dispatch                        |
| Alert acknowledge API | `apps/server/src/api/alerts.ts`       | `POST /api/alerts/:id/acknowledge`               |
| Trader dashboard      | `apps/web/src/pages/trader.tsx`       | Alert feed, acknowledge action, watchlist filter |
| Alert detail view     | `apps/web/src/pages/alert-detail.tsx` | Full enriched detail, "Propose trade" CTA stub   |

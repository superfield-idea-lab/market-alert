# Market Alert Trading System — Implementation Plan

## Goal

Deliver an event-driven corporate action alert platform for hedge fund traders: EDGAR
ingestion → enrichment → deduplication → real-time WebSocket delivery → trader UI →
outbound notifications → trade lifecycle tracking → admin oversight.

Phases 0 and 1 are complete. This plan covers the remaining implementation from Phase 2
through Phase 6, building on the existing KB substrate, task queue, passkey auth, audit
store, and encryption infrastructure.

## Non-goals

- Generative AI for alert routing or generation
- Premium vendor data sources (Bloomberg, DealReporter) — dark behind feature flags until v2
- Historical backtesting
- Automated trade execution
- Cryptocurrency or commodity asset classes

## Current State

- Phase 0 (scaffold, task queue, feature flags, CI, design system): **done**
- Phase 1 (passkeys, RLS, field encryption, audit store, mTLS, rate limiting): **done**
- Phase 2 EDGAR ingestion: stub only — `edgar-ingest-job.ts` and `corporate-action-ingestion.ts` are no-op stubs
- Phase 3 enrichment: not started
- Phase 4 WebSocket + trader UI: scout stub — WebSocket push path stubbed, `trader.tsx` renders placeholder
- Phase 5 admin panel: not started
- Phase 6 trade lifecycle: scout stubs — `mkt_trades` schema exists, API handlers return stub responses
- Phase 7 replay: partially done — `mkt-trade-replay.ts` (762 lines) has replay logic; wiring may be incomplete

## Phases

### Phase 2 — EDGAR ingestion

Goal: One real 8-K filing lands as a stored `CorporateAction` entity with encrypted
filing text, queued for enrichment. No vendor credentials required.

- [ ] Phase 2 scout: EDGAR RSS end-to-end — one 8-K stored and `ALERT_ENRICH` queued
- [ ] EDGAR ingestion worker — implement `edgar-ingest-job.ts` with ATOM feed fetch, parse, and API write
- [ ] Corporate action ingestion API — implement `POST /internal/ingestion/corporate-action` with encryption and task enqueue
- [ ] Corporate Action state machine — `Announced → Effective → Closed → Disputed` with cron and journal
- [ ] Raw filing store and EDGAR MSW fixture — commit fixture, wire MSW v2 handler, no live calls in CI

### Phase 3 — Alert enrichment pipeline

Goal: Enrichment worker processes a queued corporate action, extracts deal terms, runs
deduplication, and writes an enriched `Alert` entity through the API.

- [ ] Phase 3 scout: enrichment worker minimal vertical slice — filing text to `Enriched` alert via API
- [ ] Alert entity and state machine — `Pending → Detected → Enriched → Deduplicated → Delivered → Acknowledged → Archived`
- [ ] Terms extraction — regex/rule-based extraction of deal value, parties, dates from stored filing text
- [ ] Deduplication engine — cross-source dedup by `(ticker, event_type, announced_at ± 24h)` with journal
- [ ] Alert routing — GREEN/AMBER tier assignment; AMBER routes to analyst review queue
- [ ] Out-of-order event handling — amended filings (`8-K/A`) and `ALERT_SUPPLEMENT` task type

### Phase 4 — Real-time alert delivery and trader UI

Goal: Authenticated trader receives a push within 1 second of alert entering `Deduplicated`
state. Full alert detail, acknowledge, watchlist management, and filtering.

- [ ] Phase 4 scout: WebSocket push to trader dashboard within 1 second — replace stub with real LISTEN/NOTIFY path
- [ ] Trader alert feed — implement `trader.tsx` with live alert table, sorting, and status badges
- [ ] Alert detail view — enriched deal terms, SEC filing excerpt, source references, delta-neutral impact
- [ ] Acknowledge action — `POST /api/alerts/:id/acknowledge` with audit event and optimistic UI
- [ ] Watchlist management — add/remove tickers; watchlist filters pushed alerts
- [ ] Alert filtering — client-side filter by event type, date range, spread threshold
- [ ] Outbound notification delivery — `ALERT_NOTIFY` worker with email/SMS/webhook adapters (feature-flag-gated)

### Phase 5 — Admin panel and source configuration

Goal: Admin can toggle vendor sources, suppress false positives, view system health, and
read the audit trail.

- [ ] Phase 5 scout: source toggle and health view — Admin disables EDGAR ingestion; cron stops; health updates
- [ ] Admin dashboard shell — RLS-enforced admin layout; source configuration UI
- [ ] Alert override and suppression — Admin marks alerts as suppressed with reason; all actions audited
- [ ] System health metrics — per-source ingestion rate, circuit breaker state, queue depth view
- [ ] Audit trail view — paginated read-only audit event log; CSV export

### Phase 6 — Trade lifecycle

Goal: Traders record trades linked to alerts and advance them through
`Proposed → Executed → Settled → Reconciled`.

- [ ] Phase 6 scout: propose and execute a trade from an alert — replace stub with real trade write and state transition
- [ ] Trade state machine — full lifecycle with settlement cron, reconciliation, and Disputed state
- [ ] Trade history view — trader's own trades with state badges, linked alert, journal timeline
- [ ] Admin trade oversight — aggregate view; Admin can mark trade Disputed with notification

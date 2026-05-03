/**
 * @file index — packages/integrations
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Stub entrypoint for external vendor integrations. This package isolates all
 * third-party API clients so that MSW v2 fixture recording and HTTP interception
 * operate at a single, well-known boundary.
 *
 * ## Canonical docs
 * - docs/plan.md § packages/integrations
 * - docs/architecture.md § Vendor integration layer
 * - docs/dependencies.md § Buy/DIY table (vendor decisions)
 *
 * ## Planned modules (Phase 2+)
 * - edgar/         — EDGAR ATOM/RSS feed client with MSW fixture recording
 * - bloomberg/     — Bloomberg Data License adapter (v2, deferred)
 * - refinitiv/     — Refinitiv Eikon adapter (v2, deferred)
 *
 * ## Integration points discovered
 * - All outbound HTTP in this package must go through the fetch() wrapper in
 *   packages/core so MSW v2 can intercept it in tests (TEST-D-001).
 * - Fixtures must be recorded under tests/fixtures/integrations/ before any
 *   test in this package runs against a real external API.
 * - The EDGAR ATOM feed is the sole v1 ingestion source (source-decision
 *   2026-05-01 in docs/plan.md). Multi-vendor adapter layer deferred to v2.
 *
 * ## Risks captured
 * - EDGAR rate limits: 10 req/s per IP. The poller in Phase 2 must honour
 *   Retry-After headers and implement exponential back-off.
 * - Vendor fixture staleness: fixtures recorded in Phase 2 will drift from
 *   the live feed. The fixture-refresh.yml CI workflow must be scheduled
 *   monthly or on significant feed schema changes.
 */

// Phase 0 stub — no runtime exports yet.
// Phase 2 adds EdgarClient and the fixture-recording harness.
export {};

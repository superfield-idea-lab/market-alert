/**
 * @file index — packages/services
 *
 * ## Phase 0 — Scaffolding & infrastructure (dev-scout)
 *
 * Stub entrypoint for the shared business-service layer. This package will
 * contain domain services that are consumed by both apps/server API handlers
 * and apps/worker task workers — keeping business logic out of both the HTTP
 * layer and the worker layer.
 *
 * ## Canonical docs
 * - docs/plan.md § packages/services
 * - docs/architecture.md § Service layer
 *
 * ## Planned modules (Phase 2+)
 * - alert-service.ts  — alert creation, deduplication, enrichment dispatch
 * - edgar-service.ts  — EDGAR ATOM feed polling and corporate action parsing
 * - trader-service.ts — trader preference and delivery-channel management
 *
 * ## Integration points discovered
 * - Services must never import from 'db' directly if called from a worker
 *   context (WORKER-D-001/D-002). Workers call POST /internal/... endpoints
 *   on apps/server; only the server-side service implementations may hold DB
 *   credentials.
 * - The apps/server API handlers import from this package; apps/worker imports
 *   only the type definitions (no runtime DB access in workers).
 *
 * ## Risks captured
 * - Circular import risk: packages/services must not import from apps/server.
 *   Enforce this with a lint rule (import/no-restricted-paths) in Phase 1.
 */

// Phase 0 stub — no runtime exports yet.
// Phase 2 adds AlertService, EdgarService, TraderService.
export {};

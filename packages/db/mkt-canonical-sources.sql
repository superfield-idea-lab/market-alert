-- Market-alert schema: canonical_sources table
--
-- Phase 3 — Canonical-source discovery and ingestion (issue #74).
--
-- Blueprint refs:
--   WORKER-P-001 (API-gateway sole writer)
--   DATA-D-006   (four-pool Postgres)
--   PRD §3       (Researcher user story: discover and register venues)
--   docs/architecture.md — mkt_kb schema inventory
--
-- Design overview
-- ---------------
-- Source-discovery workers read the active Research Methodology golden document
-- (read-only) and extract the venue catalog. For each designated venue the worker
-- calls POST /internal/canonical-sources to register it. This DDL defines the
-- backing table and the associated idempotency key.
--
-- One row per unique (methodology_id, url) pair. The discovery worker uses
-- ON CONFLICT (methodology_id, url) DO NOTHING for idempotency.
--
-- Status lifecycle:  pending → active → retired
--   pending  — registered but not yet confirmed reachable by a scraper
--   active   — confirmed reachable; scraper scheduled
--   retired  — no longer polled (e.g. venue dropped from methodology)
--
-- Access:
--   Writes: POST /internal/canonical-sources (Bearer token; server → DB via mkt_app pool)
--   Reads:  GET  /internal/canonical-sources (worker Bearer token)
--   Workers never hold direct DB credentials (WORKER-T-001).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS canonical_sources (
  id               TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  -- The research_methodology golden document whose venue catalog produced this row.
  -- Soft FK — no ON DELETE CASCADE; retaining discovery history is valuable even
  -- after the methodology document is retired.
  methodology_id   TEXT        NOT NULL,
  -- Researcher (author) who owns the methodology. Used to scope reads by RLS.
  author_id        TEXT        NOT NULL,
  -- Tenant the source belongs to. Used by tenant-isolation RLS policy.
  tenant_id        TEXT        NOT NULL,
  -- Human-readable name extracted from the methodology (e.g. "SEC EDGAR").
  name             TEXT        NOT NULL,
  -- Canonical URL for the venue as declared in the methodology.
  url              TEXT        NOT NULL,
  -- Optional short description extracted from the methodology text.
  description      TEXT,
  -- Access mode declared in the methodology (e.g. "public", "authenticated", "api_key").
  -- Determines how the scraper authenticates. NULL = undeclared.
  access_mode      TEXT        CHECK (access_mode IN ('public', 'authenticated', 'api_key')),
  -- Lifecycle state.
  --   pending  — registered; not yet verified reachable
  --   active   — reachable; scraper is scheduled
  --   retired  — dropped from the active venue catalog
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'active', 'retired')),
  -- Idempotency: one row per (methodology_id, url).
  -- Re-running discovery does not create duplicate sources.
  UNIQUE (methodology_id, url),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_canonical_sources_methodology_id
  ON canonical_sources (methodology_id, status);

CREATE INDEX IF NOT EXISTS idx_canonical_sources_author_tenant
  ON canonical_sources (author_id, tenant_id, status);

INSERT INTO _schema_version (migration) VALUES ('canonical-sources-001')
  ON CONFLICT (migration) DO NOTHING;

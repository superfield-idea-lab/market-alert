-- Market-alert schema: research_topics and topic_members tables (issue #121)
--
-- Blueprint refs:
--   DATA-D-006 (four-pool Postgres)
--   PRD §3, §5 — multi-scope research programme isolation
--
-- All DDL statements are idempotent (IF NOT EXISTS, DO blocks that check
-- pg_constraint/to_regclass before altering).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- research_topics — named research programme (issue #121)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS research_topics (
  id          TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id   TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT,
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_research_topics_tenant
  ON research_topics (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- topic_members — many-to-many: research_topics × researchers (issue #121)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topic_members (
  id            TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  topic_id      TEXT        NOT NULL REFERENCES research_topics(id) ON DELETE CASCADE,
  researcher_id TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('owner', 'member')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (topic_id, researcher_id)
);

CREATE INDEX IF NOT EXISTS idx_topic_members_topic
  ON topic_members (topic_id);

CREATE INDEX IF NOT EXISTS idx_topic_members_researcher
  ON topic_members (researcher_id);

-- ---------------------------------------------------------------------------
-- Add nullable topic_id columns and update UNIQUE constraints.
-- Each block uses to_regclass() to skip gracefully if a table doesn't exist yet.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- canonical_sources
  IF to_regclass('canonical_sources') IS NOT NULL THEN
    ALTER TABLE canonical_sources ADD COLUMN IF NOT EXISTS topic_id TEXT;
  END IF;

  -- wiki_pages: add column + replace UNIQUE constraint
  IF to_regclass('wiki_pages') IS NOT NULL THEN
    ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS topic_id TEXT;

    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'wiki_pages_tenant_id_subject_type_subject_id_key'
        AND conrelid = 'wiki_pages'::regclass
    ) THEN
      ALTER TABLE wiki_pages
        DROP CONSTRAINT wiki_pages_tenant_id_subject_type_subject_id_key;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'wiki_pages_tenant_topic_subject_unique'
        AND conrelid = 'wiki_pages'::regclass
    ) THEN
      ALTER TABLE wiki_pages
        ADD CONSTRAINT wiki_pages_tenant_topic_subject_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, topic_id, subject_type, subject_id);
    END IF;
  END IF;

  -- standing_prompts: add column + replace UNIQUE constraint
  -- (standing_prompts may be created separately via STANDING_PROMPT_DDL)
  IF to_regclass('standing_prompts') IS NOT NULL THEN
    ALTER TABLE standing_prompts ADD COLUMN IF NOT EXISTS topic_id TEXT;

    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'standing_prompts_tenant_id_researcher_id_subject_type_subject_i'
        AND conrelid = 'standing_prompts'::regclass
    ) THEN
      ALTER TABLE standing_prompts
        DROP CONSTRAINT standing_prompts_tenant_id_researcher_id_subject_type_subject_i;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'standing_prompts_tenant_researcher_topic_subject_unique'
        AND conrelid = 'standing_prompts'::regclass
    ) THEN
      ALTER TABLE standing_prompts
        ADD CONSTRAINT standing_prompts_tenant_researcher_topic_subject_unique
        UNIQUE NULLS NOT DISTINCT (tenant_id, researcher_id, topic_id, subject_type, subject_id);
    END IF;
  END IF;

  -- signals
  IF to_regclass('signals') IS NOT NULL THEN
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS topic_id TEXT;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Data migration: create one 'Default' research_topic per distinct tenant_id
-- and back-fill topic_id on all existing rows. Seed topic_members for existing
-- researcher entities.
-- Idempotent: ON CONFLICT (tenant_id, name) DO NOTHING on research_topics;
--             UPDATE only touches rows where topic_id IS NULL.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tenant TEXT;
  v_topic_id TEXT;
BEGIN
  -- Build a temporary set of tenants from all tables that exist
  CREATE TEMP TABLE IF NOT EXISTS _rt_mig_tenants (tenant_id TEXT PRIMARY KEY);

  IF to_regclass('canonical_sources') IS NOT NULL THEN
    INSERT INTO _rt_mig_tenants
      SELECT DISTINCT tenant_id FROM canonical_sources WHERE tenant_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('wiki_pages') IS NOT NULL THEN
    INSERT INTO _rt_mig_tenants
      SELECT DISTINCT tenant_id FROM wiki_pages WHERE tenant_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('standing_prompts') IS NOT NULL THEN
    INSERT INTO _rt_mig_tenants
      SELECT DISTINCT tenant_id FROM standing_prompts WHERE tenant_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('signals') IS NOT NULL THEN
    INSERT INTO _rt_mig_tenants
      SELECT DISTINCT tenant_id FROM signals WHERE tenant_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  FOR tenant IN SELECT tenant_id FROM _rt_mig_tenants LOOP

    INSERT INTO research_topics (tenant_id, name, description, created_by)
    VALUES (tenant, 'Default', 'Default research topic (auto-created by migration)', 'system')
    ON CONFLICT (tenant_id, name) DO NOTHING;

    SELECT id INTO v_topic_id
    FROM research_topics
    WHERE tenant_id = tenant AND name = 'Default'
    LIMIT 1;

    IF to_regclass('canonical_sources') IS NOT NULL THEN
      UPDATE canonical_sources SET topic_id = v_topic_id
      WHERE tenant_id = tenant AND topic_id IS NULL;
    END IF;

    IF to_regclass('wiki_pages') IS NOT NULL THEN
      UPDATE wiki_pages SET topic_id = v_topic_id
      WHERE tenant_id = tenant AND topic_id IS NULL;
    END IF;

    IF to_regclass('standing_prompts') IS NOT NULL THEN
      UPDATE standing_prompts SET topic_id = v_topic_id
      WHERE tenant_id = tenant AND topic_id IS NULL;
    END IF;

    IF to_regclass('signals') IS NOT NULL THEN
      UPDATE signals SET topic_id = v_topic_id
      WHERE tenant_id = tenant AND topic_id IS NULL;
    END IF;

    IF to_regclass('entities') IS NOT NULL THEN
      INSERT INTO topic_members (topic_id, researcher_id, role)
      SELECT v_topic_id, e.id, 'owner'
      FROM entities e
      WHERE e.tenant_id = tenant
        AND e.type = 'user'
      ON CONFLICT (topic_id, researcher_id) DO NOTHING;
    END IF;

  END LOOP;

  DROP TABLE IF EXISTS _rt_mig_tenants;
END
$$;

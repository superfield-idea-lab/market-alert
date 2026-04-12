-- PostgreSQL Schema Definition
-- Strict blueprint compliance: No ORMs allowed. Property graph model.

CREATE TABLE IF NOT EXISTS entity_types (
    type TEXT PRIMARY KEY,
    schema JSONB NOT NULL,
    sensitive TEXT[] DEFAULT '{}',
    kms_key_id TEXT
);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL REFERENCES entity_types(type) ON DELETE CASCADE,
    properties JSONB NOT NULL DEFAULT '{}',
    tenant_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_tenant ON entities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_entities_properties ON entities USING GIN (properties);

CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    properties JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(type);

-- Seed required entity types
INSERT INTO entity_types (type, schema) VALUES
  ('user',        '{}'),
  ('task',        '{}'),
  ('tag',         '{}'),
  ('github_link', '{}'),
  ('channel',     '{}'),
  ('message',     '{}')
ON CONFLICT (type) DO NOTHING;

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Task queue: single-table queue for all agent types (TQ-D-001).
-- delegated_token stores the single-use JWT issued at task creation.
-- The token is encrypted at rest in the column; workers receive it only
-- through the claim API response.
CREATE TABLE IF NOT EXISTS task_queue (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    idempotency_key TEXT UNIQUE NOT NULL,
    agent_type TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','claimed','running','submitting','completed','failed','dead')),
    payload JSONB NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL,
    correlation_id TEXT,
    claimed_by TEXT,
    claimed_at TIMESTAMP WITH TIME ZONE,
    claim_expires_at TIMESTAMP WITH TIME ZONE,
    delegated_token TEXT,
    result JSONB,
    error_message TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    priority INTEGER NOT NULL DEFAULT 5,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent fix: ensure id column has a default for existing databases
ALTER TABLE task_queue ALTER COLUMN id SET DEFAULT gen_random_uuid()::TEXT;


CREATE INDEX IF NOT EXISTS idx_task_queue_poll
    ON task_queue (agent_type, status, priority, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_task_queue_stale
    ON task_queue (status, claim_expires_at)
    WHERE status = 'claimed';

-- Idempotency deduplication index (also enforced by UNIQUE constraint above)
CREATE INDEX IF NOT EXISTS idx_task_queue_idempotency
    ON task_queue (idempotency_key);

-- Note: ALTER TABLE task_queue ENABLE ROW LEVEL SECURITY is executed by
-- init-remote.ts (requires table ownership — the admin user owns the table).
-- Per-type RLS policies are also applied there after agent roles are created.

-- Per-type filtered views: expose only non-sensitive columns to each agent type.
-- Sensitive columns excluded: delegated_token, created_by, result, error_message.
CREATE OR REPLACE VIEW task_queue_view_coding AS
    SELECT
        id,
        agent_type,
        job_type,
        status,
        payload,
        correlation_id,
        claimed_by,
        claimed_at,
        claim_expires_at,
        attempt,
        max_attempts,
        next_retry_at,
        priority,
        created_at,
        updated_at
    FROM task_queue
    WHERE agent_type = 'coding';

CREATE OR REPLACE VIEW task_queue_view_analysis AS
    SELECT
        id,
        agent_type,
        job_type,
        status,
        payload,
        correlation_id,
        claimed_by,
        claimed_at,
        claim_expires_at,
        attempt,
        max_attempts,
        next_retry_at,
        priority,
        created_at,
        updated_at
    FROM task_queue
    WHERE agent_type = 'analysis';

CREATE OR REPLACE VIEW task_queue_view_code_cleanup AS
    SELECT
        id,
        agent_type,
        job_type,
        status,
        payload,
        correlation_id,
        claimed_by,
        claimed_at,
        claim_expires_at,
        attempt,
        max_attempts,
        next_retry_at,
        priority,
        created_at,
        updated_at
    FROM task_queue
    WHERE agent_type = 'code_cleanup';

-- KB-demo worker-phase views (issue #95, TQ-D-001).
-- Sensitive columns excluded: delegated_token, created_by, result, error_message.

CREATE OR REPLACE VIEW task_queue_view_email_ingest AS
    SELECT
        id, agent_type, job_type, status, payload, correlation_id,
        claimed_by, claimed_at, claim_expires_at,
        attempt, max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE agent_type = 'email_ingest';

CREATE OR REPLACE VIEW task_queue_view_autolearn AS
    SELECT
        id, agent_type, job_type, status, payload, correlation_id,
        claimed_by, claimed_at, claim_expires_at,
        attempt, max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE agent_type = 'autolearn';

CREATE OR REPLACE VIEW task_queue_view_transcription AS
    SELECT
        id, agent_type, job_type, status, payload, correlation_id,
        claimed_by, claimed_at, claim_expires_at,
        attempt, max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE agent_type = 'transcription';

CREATE OR REPLACE VIEW task_queue_view_annotation AS
    SELECT
        id, agent_type, job_type, status, payload, correlation_id,
        claimed_by, claimed_at, claim_expires_at,
        attempt, max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE agent_type = 'annotation';

CREATE OR REPLACE VIEW task_queue_view_deepclean AS
    SELECT
        id, agent_type, job_type, status, payload, correlation_id,
        claimed_by, claimed_at, claim_expires_at,
        attempt, max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE agent_type = 'deepclean';

CREATE OR REPLACE VIEW task_queue_view_bdm_summary AS
    SELECT
        id, agent_type, job_type, status, payload, correlation_id,
        claimed_by, claimed_at, claim_expires_at,
        attempt, max_attempts, next_retry_at, priority, created_at, updated_at
    FROM task_queue
    WHERE agent_type = 'bdm_summary';

-- LISTEN/NOTIFY trigger: wake the appropriate worker channel on task insertion.
-- Blueprint: TQ-D-005 (listen-notify-wake)
CREATE OR REPLACE FUNCTION notify_task_queue_insert()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('task_queue_' || NEW.agent_type, NEW.id::TEXT);
    PERFORM pg_notify('task_queue_admin', json_build_object(
        'event', 'task_queue.created',
        'id', NEW.id,
        'status', NEW.status,
        'agent_type', NEW.agent_type,
        'job_type', NEW.job_type,
        'created_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'updated_at', to_char(NEW.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::TEXT);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_task_queue_notify ON task_queue;
CREATE TRIGGER trg_task_queue_notify
    AFTER INSERT ON task_queue
    FOR EACH ROW EXECUTE FUNCTION notify_task_queue_insert();

-- LISTEN/NOTIFY trigger: notify admin monitor channel on task status update.
CREATE OR REPLACE FUNCTION notify_task_queue_update()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('task_queue_admin', json_build_object(
        'event', 'task_queue.updated',
        'id', NEW.id,
        'status', NEW.status,
        'agent_type', NEW.agent_type,
        'job_type', NEW.job_type,
        'created_at', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'updated_at', to_char(NEW.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::TEXT);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_task_queue_admin_notify ON task_queue;
CREATE TRIGGER trg_task_queue_admin_notify
    AFTER UPDATE ON task_queue
    FOR EACH ROW EXECUTE FUNCTION notify_task_queue_update();

-- Passkey / WebAuthn credentials
-- Stores the public key credential registered by the user's authenticator.
-- credential_id: base64url-encoded credential ID from the authenticator
-- public_key: CBOR-encoded public key stored as hex bytes
-- counter: signature counter for clone detection (reject if presented <= stored)
-- aaguid: authenticator AAGUID (identifies the authenticator model)
-- transports: array of transport hints (usb, nfc, ble, hybrid, internal)
CREATE TABLE IF NOT EXISTS passkey_credentials (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    user_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key BYTEA NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    aaguid TEXT NOT NULL DEFAULT '',
    transports TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_passkey_credentials_user_id ON passkey_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_passkey_credentials_credential_id ON passkey_credentials(credential_id);

-- Passkey challenge store
-- Short-lived challenges (5-minute TTL) used to prevent replay attacks during
-- WebAuthn registration and authentication ceremonies.
CREATE TABLE IF NOT EXISTS passkey_challenges (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    user_id TEXT REFERENCES entities(id) ON DELETE CASCADE,
    challenge TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user_id ON passkey_challenges(user_id);
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_challenge ON passkey_challenges(challenge);

-- Worker vendor credentials — encrypted Codex subscription auth material.
-- Stores the minimum authentication state required to restore a Codex session
-- inside an ephemeral worker container at boot.
--
-- auth_bundle: AES-256-GCM encrypted JSON blob (enc:v1:<iv>:<ciphertext> format).
--   Contains the Codex session material (access token, refresh token, expiry, etc.)
--   Never stored in plaintext. Workers decrypt at startup using ENCRYPTION_MASTER_KEY.
-- agent_type:  Agent type this credential is scoped to (e.g. "coding").
-- expires_at:  When the auth bundle itself expires (independent of token expiry).
--   Workers must refuse to use expired bundles.
-- created_by:  User or system that stored the credential.
-- revoked_at:  Set when the credential is explicitly revoked; workers must reject revoked bundles.
CREATE TABLE IF NOT EXISTS worker_credentials (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    agent_type TEXT NOT NULL,
    auth_bundle TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_worker_credentials_agent_type
    ON worker_credentials (agent_type, expires_at)
    WHERE revoked_at IS NULL;

-- API keys for machine-to-machine authentication
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- Feature flags table (PRUNE-D-002, PRUNE-D-003, PRUNE-C-002)
-- Stores each shipped-but-gated feature as a row with lifecycle columns.
-- state CHECK constraint enforces the three-value lifecycle: enabled →
-- deprecated → disabled.
-- scheduled_disable_at: when the cron job should flip state to disabled
-- disabled_at:          when the row was actually disabled
-- removal_eligible_at:  earliest date a code-removal PR is allowed
CREATE TABLE IF NOT EXISTS feature_flags (
  name                TEXT PRIMARY KEY,
  state               TEXT NOT NULL DEFAULT 'enabled'
                        CHECK (state IN ('enabled', 'deprecated', 'disabled')),
  owner               TEXT NOT NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scheduled_disable_at TIMESTAMP WITH TIME ZONE,
  disabled_at         TIMESTAMP WITH TIME ZONE,
  removal_eligible_at  TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_state ON feature_flags (state);
CREATE INDEX IF NOT EXISTS idx_feature_flags_scheduled_disable
  ON feature_flags (scheduled_disable_at)
  WHERE scheduled_disable_at IS NOT NULL AND state = 'enabled';

-- Seed row: assemblyai_transcription legacy path (PRUNE-A-003)
-- Phase 5 ships this route off-by-default via DB flag, not env var.
INSERT INTO feature_flags (name, state, owner)
VALUES ('assemblyai_transcription', 'enabled', 'product')
ON CONFLICT (name) DO NOTHING;

-- Extend passkey_challenges type to include 'recovery' (AUTH-C-016/017).
-- The ALTER ... DROP CONSTRAINT / ADD CONSTRAINT pattern is idempotent via
-- the DO block guard so the schema can be applied to both fresh and existing
-- databases without errors.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'passkey_challenges_type_check'
      AND conrelid = 'passkey_challenges'::regclass
  ) THEN
    ALTER TABLE passkey_challenges
      DROP CONSTRAINT passkey_challenges_type_check;
    ALTER TABLE passkey_challenges
      ADD CONSTRAINT passkey_challenges_type_check
      CHECK (type IN ('registration', 'authentication', 'recovery'));
  END IF;
END;
$$;

-- Scoped single-use worker tokens (issue #36).
-- Each row represents one minted token tied to a specific pod and task scope.
-- Tokens are single-use: consumed_at is set on first use, and any further use
-- is rejected.  pod_terminate invalidates all still-unused tokens for the pod.
--
-- pod_id:        Identifies the worker pod (e.g. Kubernetes pod name or UUID).
-- agent_type:    Agent type this token is scoped to (e.g. "coding").
-- task_scope:    Opaque task identifier this token authorises (e.g. task_queue id).
-- jti:           JWT ID embedded in the signed token; matches revoked_tokens on consumption.
-- expires_at:    Pod-lifetime TTL — tokens cannot outlive the pod's scheduled lifetime.
-- consumed_at:   Set when the token is first used (single-use enforcement).
-- invalidated_at: Set when pod terminate fires before the token is consumed.
-- created_at:    Issuance timestamp for audit.
CREATE TABLE IF NOT EXISTS worker_tokens (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  pod_id          TEXT NOT NULL,
  agent_type      TEXT NOT NULL,
  task_scope      TEXT NOT NULL,
  jti             TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed_at     TIMESTAMP WITH TIME ZONE,
  invalidated_at  TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_worker_tokens_pod_id
  ON worker_tokens (pod_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_worker_tokens_jti
  ON worker_tokens (jti);

-- Recovery passphrases (AUTH-C-016).
-- Stores a bcrypt/argon2-equivalent hash of the user's recovery passphrase.
-- Only one active passphrase per user at a time (the latest replaces older ones).
-- passphrase_hash: PBKDF2-SHA-256 derived key stored as hex (rounds=210000).
CREATE TABLE IF NOT EXISTS recovery_passphrases (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  passphrase_hash TEXT NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recovery_passphrases_user_id
  ON recovery_passphrases (user_id);

-- Auth lockout — progressive delay state per user (AUTH-C-024, AUTH-C-032).
-- failed_count: number of consecutive failed passkey assertion attempts.
-- delay_until:  wall-clock time before the next attempt is accepted.
-- locked_until: full temporary lockout expiry (set after many failures).
-- Resets to 0 on a successful assertion.
CREATE TABLE IF NOT EXISTS auth_lockout (
  user_id       TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  delay_until   TIMESTAMP WITH TIME ZONE,
  locked_until  TIMESTAMP WITH TIME ZONE,
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Business journal (DATA-D-004, DATA-C-026/027, TEST-D-006, TEST-C-014).
-- Separate from the audit log: the audit log records access events for compliance,
-- while the business journal records consequential business operations (WikiPageVersion
-- published, LegalHold placed, key rotation, etc.) with enough information to
-- deterministically reconstruct state from first principles.
-- The table is append-only: no UPDATE or DELETE privileges are granted to app_rw
-- (enforced by init-remote.ts which explicitly revokes those privileges after the
-- default GRANT ALL that configureAppDatabase issues for schema ownership).
CREATE TABLE IF NOT EXISTS business_journal (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  event_type  TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  payload_ref TEXT,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_business_journal_event_type
  ON business_journal (event_type);
CREATE INDEX IF NOT EXISTS idx_business_journal_entity_id
  ON business_journal (entity_id);
CREATE INDEX IF NOT EXISTS idx_business_journal_created_at
  ON business_journal (created_at);

-- Tenant retention policies (issue #33, Phase 2).
-- Stores the default retention_class and legal_hold values for each tenant.
-- Ingestion workers MUST look up this row before writing an Email or CorpusChunk.
-- A missing row blocks ingestion — there is no fall-through default at the DB layer.
--
-- retention_class: an opaque policy pointer (e.g. "standard", "mifid2-7yr").
--   Phase 8 builds the policy engine that interprets this value.
--   Phase 2 only writes and reads it.
-- legal_hold_default: whether all newly ingested entities for this tenant start
--   under a legal hold. Typically false; set true when a hold is raised.
CREATE TABLE IF NOT EXISTS tenant_retention_policies (
  tenant_id            TEXT PRIMARY KEY,
  retention_class      TEXT NOT NULL,
  legal_hold_default   BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Retention metadata columns on entities (issue #33).
-- Only Email and CorpusChunk rows are required to have non-null values; other
-- entity types leave them null. The application layer (retention-store.ts)
-- enforces non-null population for ground-truth entity types at write time.
ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS retention_class TEXT,
  ADD COLUMN IF NOT EXISTS legal_hold      BOOLEAN;

-- Immutability trigger for retention_class and legal_hold on entities (issue #33).
-- Once set on INSERT (non-null), neither field may be changed via UPDATE.
-- The Phase 8 retention engine is the sole actor that may legitimately change
-- these values; it will connect as a privileged admin role, not as app_rw.
CREATE OR REPLACE FUNCTION guard_retention_immutable()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.retention_class IS NOT NULL AND NEW.retention_class IS DISTINCT FROM OLD.retention_class THEN
    RAISE EXCEPTION 'retention_class is immutable after initial write (entity id=%)', OLD.id;
  END IF;
  IF OLD.legal_hold IS NOT NULL AND NEW.legal_hold IS DISTINCT FROM OLD.legal_hold THEN
    RAISE EXCEPTION 'legal_hold is immutable after initial write (entity id=%)', OLD.id;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_entities_retention_immutable ON entities;
CREATE TRIGGER trg_entities_retention_immutable
  BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION guard_retention_immutable();

-- Tenant policies — per-tenant overridable configuration values.
-- key: policy name (e.g. 'autolearn_cron_interval')
-- value: policy value as text (callers cast to the appropriate type)
-- tenant_id: NULL means the row is a global default; a non-NULL tenant_id
--   overrides the global default for that tenant.
-- Unique constraint on (tenant_id, key) allows ON CONFLICT upserts.
-- PRUNE-A-003: frequency is tenant-overridable via this table, not a hard-coded constant.
CREATE TABLE IF NOT EXISTS tenant_policies (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id   TEXT,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tenant_policies_tenant_key_uniq UNIQUE NULLS NOT DISTINCT (tenant_id, key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_policies_tenant_key
  ON tenant_policies (tenant_id, key);

-- Seed global default: autolearn cron fires every 15 minutes.
INSERT INTO tenant_policies (tenant_id, key, value)
VALUES (NULL, 'autolearn_cron_interval', '*/15 * * * *')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Migration version tracking table.
-- Records each named migration that has been applied to this database.
-- ENV-D-002: the same migration runner is used identically in dev, CI, and prod.
-- ENV-C-016: migrate() records the baseline migration name here after applying
--            the schema so CI can verify a fresh bootstrap produces exactly one row.
CREATE TABLE IF NOT EXISTS _schema_version (
  migration TEXT PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Baseline migration record: marks the initial schema as applied.
-- INSERT … ON CONFLICT DO NOTHING makes this idempotent.
INSERT INTO _schema_version (migration) VALUES ('baseline-001')
  ON CONFLICT (migration) DO NOTHING;

-- ---------------------------------------------------------------------------
-- M-of-N approval for privileged operations (issue #24)
--
-- Root-key and bulk-export operations route through a pending-approval record.
-- The action does not execute until at least M of N designated approvers have
-- signed off. Approvals and rejections are audited.
--
-- operation_type: identifies the protected operation (e.g. 'root_key_rotate',
--                 'bulk_export').
-- payload:        operation-specific parameters needed at execution time.
-- requested_by:   user ID of the initiating actor.
-- required_approvals: M — the quorum threshold.
-- status: 'pending' → 'approved' (quorum reached) → 'executed' | 'rejected'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_requests (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  operation_type      TEXT NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}',
  requested_by        TEXT NOT NULL,
  required_approvals  INTEGER NOT NULL DEFAULT 2 CHECK (required_approvals >= 1),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests (status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_requested_by
  ON approval_requests (requested_by);
CREATE INDEX IF NOT EXISTS idx_approval_requests_operation_type
  ON approval_requests (operation_type);

-- Individual approval or rejection votes on a pending approval request.
-- approver_id: user ID of the designated approver.
-- decision: 'approved' or 'rejected'.
-- One vote per (request, approver) pair — enforced by unique constraint.
CREATE TABLE IF NOT EXISTS approval_votes (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  request_id    TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  approver_id   TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment       TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (request_id, approver_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_votes_request_id
  ON approval_votes (request_id);
CREATE INDEX IF NOT EXISTS idx_approval_votes_approver_id
  ON approval_votes (approver_id);

-- ---------------------------------------------------------------------------
-- Wiki page versions (issue #39, #44) — autolearn draft output
--
-- Stores versioned drafts of wiki pages written by the autolearn worker.
-- All worker-written rows land in 'draft' state.  Publication (moving to
-- 'published') is handled by the Phase 6 publication gate UI and is out of
-- scope here.
--
-- page_id:     Opaque identifier for the wiki page (dept + customer slug or
--              any client-supplied stable key).
-- dept:        Department scope — must match the token's dept claim.
-- customer:    Customer scope — must match the token's customer claim.
-- content:     Markdown body of the draft.
-- state:       Lifecycle state — 'draft' | 'published' | 'archived'.
-- created_by:  actor_id of the worker token (sub claim).
-- source_task: task_queue.id that triggered this write, for auditability.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wiki_page_versions (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  page_id       TEXT NOT NULL,
  dept          TEXT NOT NULL,
  customer      TEXT NOT NULL,
  content       TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft', 'published', 'archived')),
  created_by    TEXT NOT NULL,
  source_task   TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_page_id
  ON wiki_page_versions (page_id);
CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_dept_customer
  ON wiki_page_versions (dept, customer);
CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_state
  ON wiki_page_versions (state);

-- ============================================================================
-- wiki_page_versions embedding column (issue #44, PRD §7)
-- ============================================================================
-- Guarded by pgvector availability — mirrors the corpus_chunks pattern.
--
-- When the vector extension IS available this block:
--   - Adds a vector(768) embedding column to wiki_page_versions
--   - Creates an HNSW index for draft similarity search by the autolearn worker
--
-- PRD §7 compensating controls (same as corpus_chunks):
--   1. Audit:         every similarity query emits an audit event before data flows.
--   2. Rate limit:    per-tenant query rate enforced in the application layer.
--   3. No public API: the embedding column is never serialised into any API response.
--   4. Tenant scoping: (dept, customer) columns used as tenant key for all queries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $exec$
      ALTER TABLE wiki_page_versions
        ADD COLUMN IF NOT EXISTS embedding vector(768)
    $exec$;

    EXECUTE $exec$
      CREATE INDEX IF NOT EXISTS idx_wiki_page_versions_embedding_hnsw
          ON wiki_page_versions
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64)
    $exec$;

    INSERT INTO _schema_version (migration) VALUES ('wiki-version-embed-001')
      ON CONFLICT (migration) DO NOTHING;
  END IF;
END;
$$;

-- ============================================================================
-- Autolearn jobs — PRD §4.3 state machine (issue #42)
--
-- Tracks the lifecycle of each ephemeral autolearn worker run.
-- One row per pod invocation; state advances through the PRD §4.3 machine:
--
--   WORKER_STARTED → FETCHING_GROUND_TRUTH → FETCHING_WIKI
--     → WRITING_TEMP_FILES → CLAUDE_CLI_RUNNING → WRITING_NEW_VERSION
--     → EMBEDDING → AWAITING_REVIEW → PUBLISHED → COMPLETE
--
--   AWAITING_REVIEW → REJECTED  (reviewer rejects draft)
--   Any state       → FAILED    (unrecoverable error; previous wiki retained)
--
-- source_type: 'gardening' (scheduled cron) or 'deepclean' (on-demand admin).
-- wiki_version_id: set when WRITING_NEW_VERSION succeeds; FK to wiki_page_versions.
-- task_queue_id:   optional link back to the task_queue row that spawned this job.
-- ============================================================================
CREATE TABLE IF NOT EXISTS autolearn_jobs (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id        TEXT NOT NULL,
  customer_id      TEXT NOT NULL,
  dept_id          TEXT NOT NULL,
  source_type      TEXT NOT NULL DEFAULT 'gardening'
                     CHECK (source_type IN ('gardening', 'deepclean')),
  state            TEXT NOT NULL DEFAULT 'WORKER_STARTED'
                     CHECK (state IN (
                       'WORKER_STARTED',
                       'FETCHING_GROUND_TRUTH',
                       'FETCHING_WIKI',
                       'WRITING_TEMP_FILES',
                       'CLAUDE_CLI_RUNNING',
                       'WRITING_NEW_VERSION',
                       'EMBEDDING',
                       'AWAITING_REVIEW',
                       'PUBLISHED',
                       'REJECTED',
                       'COMPLETE',
                       'FAILED'
                     )),
  task_queue_id              TEXT,
  error_message              TEXT,
  wiki_version_id            TEXT,
  -- Set to TRUE when the customer has reached the hallucination-escalation
  -- threshold (three DISMISSED annotations in 30 days, PRD §9 / issue #67).
  -- When true the publication gate must route the draft to explicit human
  -- approval regardless of its materiality score.
  requires_explicit_approval BOOLEAN NOT NULL DEFAULT false,
  created_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_autolearn_jobs_tenant_customer
  ON autolearn_jobs (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_autolearn_jobs_state
  ON autolearn_jobs (state);
CREATE INDEX IF NOT EXISTS idx_autolearn_jobs_created_at
  ON autolearn_jobs (created_at DESC);

-- ============================================================================
-- pgvector HNSW index -- CorpusChunk embedding column (issue #31, PRD §7)
-- ============================================================================
-- The entire corpus_chunks DDL block is guarded by a pgvector availability
-- check so that databases without the vector extension (e.g. plain postgres:16
-- in unit-test environments) do not fail during schema migration.
--
-- When the vector extension IS available (installed by init-remote.ts as
-- superuser before migrateAppSchema runs) this block creates:
--   - corpus_chunks table with a vector(768) embedding column
--   - b-tree tenant_id index
--   - HNSW index (m=16, ef_construction=64) on the embedding column
--   - RLS + per-tenant isolation policy
--
-- PRD §7 compensating controls:
--   1. Audit:         every similarity query emits an audit event before data flows.
--   2. Rate limit:    per-tenant query rate enforced in the application layer.
--   3. No public API: the embedding column is never serialised into any API response.
--   4. RLS:           per-tenant scoping via corpus_chunks_tenant_isolation policy.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $exec$
      CREATE TABLE IF NOT EXISTS corpus_chunks (
          id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
          tenant_id   TEXT NOT NULL,
          source_id   TEXT,
          content     TEXT NOT NULL,
          embedding   vector(768),
          chunk_index INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    $exec$;

    EXECUTE $exec$
      CREATE INDEX IF NOT EXISTS idx_corpus_chunks_tenant_id
          ON corpus_chunks (tenant_id)
    $exec$;

    EXECUTE $exec$
      CREATE INDEX IF NOT EXISTS idx_corpus_chunks_embedding_hnsw
          ON corpus_chunks
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64)
    $exec$;

    EXECUTE $exec$
      ALTER TABLE corpus_chunks ENABLE ROW LEVEL SECURITY
    $exec$;
    EXECUTE $exec$
      ALTER TABLE corpus_chunks FORCE ROW LEVEL SECURITY
    $exec$;

    EXECUTE $exec$
      DROP POLICY IF EXISTS corpus_chunks_tenant_isolation ON corpus_chunks
    $exec$;
    EXECUTE $exec$
      CREATE POLICY corpus_chunks_tenant_isolation
          ON corpus_chunks
          FOR ALL
          USING (
              tenant_id = current_setting('app.current_tenant_id', true)
          )
    $exec$;

    INSERT INTO _schema_version (migration) VALUES ('pgvector-hnsw-001')
      ON CONFLICT (migration) DO NOTHING;
  END IF;
END;
$$;

-- ============================================================================
-- Annotation threads (issue #63) — inline anchored thread storage
-- ============================================================================
--
-- Stores annotation threads created by RMs on wiki page versions.
-- Each thread is anchored to a text passage via a character-offset anchor
-- (start_offset, end_offset) and a quoted_text excerpt for re-anchoring
-- after minor edits (fuzzy match).
--
-- wiki_version_id: FK to wiki_page_versions.id — scope threads to a version.
-- anchor_text:     The selected text excerpt at thread creation time.
--                  Used for fuzzy re-anchoring when the version's content changes.
-- start_offset:    Character offset of the selection start in the version content.
-- end_offset:      Character offset of the selection end in the version content.
-- body:            Initial comment text.
-- created_by:      User ID of the RM who opened the thread.
-- resolved:        True when the thread has been marked resolved.
-- resolved_by:     User ID of the actor who resolved it.
-- resolved_at:     Timestamp of resolution.
--
-- Replies are stored in annotation_replies (separate table for clean pagination).
-- ============================================================================
CREATE TABLE IF NOT EXISTS annotation_threads (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  wiki_version_id  TEXT NOT NULL REFERENCES wiki_page_versions(id) ON DELETE CASCADE,
  anchor_text      TEXT NOT NULL,
  start_offset     INTEGER NOT NULL,
  end_offset       INTEGER NOT NULL,
  body             TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  resolved         BOOLEAN NOT NULL DEFAULT false,
  resolved_by      TEXT,
  resolved_at      TIMESTAMP WITH TIME ZONE,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_annotation_threads_wiki_version_id
  ON annotation_threads (wiki_version_id);
CREATE INDEX IF NOT EXISTS idx_annotation_threads_created_by
  ON annotation_threads (created_by);

-- Replies to annotation threads.
-- Each reply belongs to exactly one thread.
CREATE TABLE IF NOT EXISTS annotation_replies (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  thread_id  TEXT NOT NULL REFERENCES annotation_threads(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_annotation_replies_thread_id
  ON annotation_replies (thread_id);

INSERT INTO _schema_version (migration) VALUES ('annotation-threads-001')
  ON CONFLICT (migration) DO NOTHING;

-- ============================================================================
-- Hallucination escalation dismissal log (issue #67, PRD §9)
--
-- Records each DISMISSED annotation event per customer so the publication
-- gate can count dismissals in a rolling 30-day window without requiring
-- cross-table joins through annotation_threads → wiki_page_versions.
--
-- customer_id:   The customer whose annotation was dismissed.
-- annotation_id: The annotation thread ID that was dismissed.
-- dismissed_at:  Timestamp of the DISMISSED transition.
-- ============================================================================
CREATE TABLE IF NOT EXISTS annotation_dismissal_log (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  customer_id   TEXT NOT NULL,
  annotation_id TEXT NOT NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_annotation_dismissal_log_customer_dismissed
  ON annotation_dismissal_log (customer_id, dismissed_at DESC);

INSERT INTO _schema_version (migration) VALUES ('hallucination-escalation-001')
  ON CONFLICT (migration) DO NOTHING;

-- ============================================================================
-- Phase 8 — Retention policy engine scout (issue #78)
--
-- Named retention policy catalogue and a database-layer deletion block.
--
-- retention_policies: catalogue of named policy definitions. Each row encodes
--   a named compliance regime (e.g. "mifid2-5yr") with a floor in whole days.
--   The `retention_class` TEXT stored on entities and tenant_retention_policies
--   is a foreign key (soft reference) into this table's `name` column.
--
-- guard_retention_floor(): BEFORE DELETE trigger function that rejects premature
--   deletion of any entity whose retention_class maps to a named policy whose
--   floor has not yet elapsed. The check compares NOW() against
--   (entities.created_at + retention_floor_days * INTERVAL '1 day').
--   Only entities with a non-null retention_class are checked — unclassified
--   rows can be freely deleted.
--
-- trg_entities_retention_floor: wires guard_retention_floor to entities so
--   every DELETE attempt is evaluated at the database layer, regardless of
--   which role or connection issues the statement.
--
-- mifid2-5yr seed fixture: the canonical MiFID II Art. 16(6) 5-year regime
--   used by Phase 8 integration tests and tenant onboarding.
--
-- Integration risks discovered during scout:
--   - The retention scheduler (future issue) must connect as a privileged role
--     that is exempt from this trigger (or the trigger must check a session var).
--     For now the trigger blocks ALL roles, which is correct for the scout.
--   - Legal hold (future issue) must extend the floor check: held entities
--     cannot be deleted even after the floor has elapsed.
--   - WORM mode (future issue) must also add an immutability layer on INSERT/UPDATE.
--
-- Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
-- ============================================================================

CREATE TABLE IF NOT EXISTS retention_policies (
  name                 TEXT PRIMARY KEY,
  description          TEXT NOT NULL DEFAULT '',
  retention_floor_days INTEGER NOT NULL CHECK (retention_floor_days >= 0),
  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed the canonical MiFID II 5-year (1826 days) fixture policy.
-- 5 years × 365 days + 1 leap day = 1826 days (conservative floor).
INSERT INTO retention_policies (name, description, retention_floor_days)
VALUES (
  'mifid2-5yr',
  'MiFID II Art. 16(6) — 5-year minimum retention for investment records',
  1826
)
ON CONFLICT (name) DO NOTHING;

-- Deletion-block trigger: rejects DELETE on entities whose retention floor
-- has not yet elapsed.  Only entities with a non-null retention_class that
-- resolves to a row in retention_policies are affected.
CREATE OR REPLACE FUNCTION guard_retention_floor()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  floor_days INTEGER;
BEGIN
  IF OLD.retention_class IS NULL THEN
    RETURN OLD;
  END IF;

  SELECT retention_floor_days INTO floor_days
    FROM retention_policies
   WHERE name = OLD.retention_class;

  IF NOT FOUND THEN
    -- Unknown retention_class: no floor configured, allow deletion.
    RETURN OLD;
  END IF;

  IF NOW() < OLD.created_at + (floor_days * INTERVAL '1 day') THEN
    RAISE EXCEPTION
      'retention floor not reached: entity % (class=%) cannot be deleted until %',
      OLD.id,
      OLD.retention_class,
      (OLD.created_at + (floor_days * INTERVAL '1 day'))::DATE
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_entities_retention_floor ON entities;
CREATE TRIGGER trg_entities_retention_floor
  BEFORE DELETE ON entities
  FOR EACH ROW EXECUTE FUNCTION guard_retention_floor();

INSERT INTO _schema_version (migration) VALUES ('retention-engine-scout-001')
  ON CONFLICT (migration) DO NOTHING;

-- ============================================================================
-- Phase 8 — Retention policy schema with tenant-scoped assignment (issue #79)
--
-- Extends the scout's flat retention_policies table with:
--
-- 1. retention_policy_entity_overrides: per-entity-type retention floor
--    overrides. Allows a policy to specify different retention periods for
--    different entity types (e.g. email may require 7 years under MiFID II
--    while corpus_chunk requires 5 years). Rows here take precedence over
--    retention_policies.retention_floor_days for the matching entity type.
--
-- 2. SEC 17a-4(f) default policy seed: 6-year minimum retention for broker-
--    dealer records, as required by SEC Rule 17a-4(f).
--
-- 3. tenant_retention_policy_assignments audit log: every assignment of a
--    named policy to a tenant is written here, preserving the actor_id and
--    timestamp so that compliance audits can reconstruct the history of
--    policy changes.
--
-- The application-layer assignment path (retention-engine.ts) is restricted
-- to the compliance_officer role; the assignment emits an audit event via
-- the server audit-service before writing to tenant_retention_policies.
--
-- Canonical docs: docs/PRD.md §7a, docs/implementation-plan-v1.md Phase 8
-- ============================================================================

-- Seed the SEC 17a-4(f) 6-year (2192 days) default policy.
-- 6 years × 365 days + 1 leap day = 2191 days; using 2192 as conservative floor.
INSERT INTO retention_policies (name, description, retention_floor_days)
VALUES (
  'sec17a4-6yr',
  'SEC Rule 17a-4(f) — 6-year minimum retention for broker-dealer records',
  2192
)
ON CONFLICT (name) DO NOTHING;

-- Per-entity-type retention floor overrides for named policies.
-- When a row exists for (policy_name, entity_type), the override
-- retention_floor_days is used instead of retention_policies.retention_floor_days
-- for entities of that type. A missing row means the policy-level default applies.
CREATE TABLE IF NOT EXISTS retention_policy_entity_overrides (
  policy_name          TEXT NOT NULL REFERENCES retention_policies (name) ON DELETE CASCADE,
  entity_type          TEXT NOT NULL,
  retention_floor_days INTEGER NOT NULL CHECK (retention_floor_days >= 0),
  description          TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (policy_name, entity_type)
);

-- Audit log for tenant retention policy assignments.
-- Every call to assignRetentionPolicyToTenant is recorded here.
-- actor_id: the user who performed the assignment.
-- previous_policy: the policy that was in force before this assignment (NULL if none).
CREATE TABLE IF NOT EXISTS tenant_retention_policy_assignments (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  tenant_id        TEXT NOT NULL,
  policy_name      TEXT NOT NULL REFERENCES retention_policies (name),
  actor_id         TEXT NOT NULL,
  previous_policy  TEXT,
  assigned_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trpa_tenant_assigned
  ON tenant_retention_policy_assignments (tenant_id, assigned_at DESC);

INSERT INTO _schema_version (migration) VALUES ('retention-policy-schema-001')
  ON CONFLICT (migration) DO NOTHING;

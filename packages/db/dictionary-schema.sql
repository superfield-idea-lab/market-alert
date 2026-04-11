-- kb_dictionary: IdentityDictionary database schema
-- Role: dict_rw — read/write on kb_dictionary only.
-- No other role holds any privilege on these tables.
--
-- DATA-D-006: structural isolation from kb_app, kb_audit, kb_analytics.
-- app_rw cannot SELECT from these tables (blocked at the database layer).
-- dict_rw cannot SELECT from kb_app tables.
-- Encryption key domain: identity-key (disjoint from all other domains).

-- Identity token table: maps anonymisation tokens to real-world identities.
-- Sensitive columns (real_name, real_email, real_org) are encrypted at rest
-- using the identity-key domain before INSERT by the FieldEncryptor.
-- The token column is the anonymisation key used throughout kb_app — it
-- contains no PII and may be passed to the app database safely.
CREATE TABLE IF NOT EXISTS identity_tokens (
    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    token       TEXT NOT NULL UNIQUE,   -- anonymisation key; used in kb_app as identity ref
    real_name   TEXT NOT NULL,          -- encrypted: identity-key domain
    real_email  TEXT NOT NULL,          -- encrypted: identity-key domain
    real_org    TEXT NOT NULL,          -- encrypted: identity-key domain
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_tokens_token ON identity_tokens(token);
CREATE INDEX IF NOT EXISTS idx_identity_tokens_created_at ON identity_tokens(created_at);

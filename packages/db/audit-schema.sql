-- Audit database schema
-- Append-only, hash-chained audit event log.
-- All rows are immutable after insert. No UPDATE or DELETE permissions
-- should be granted to the audit_w role.

CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before JSONB,
    after JSONB,
    ip TEXT,
    user_agent TEXT,
    correlation_id TEXT,
    ts TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
);

-- Allow adding correlation_id to existing deployments that were created before
-- this column was introduced.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS correlation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);

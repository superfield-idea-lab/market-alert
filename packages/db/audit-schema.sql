-- Audit database schema
-- Append-only, hash-chained audit event log.
-- All rows are immutable after insert. Immutability is enforced by the
-- audit_events_immutable triggers below — UPDATE/DELETE/TRUNCATE are blocked
-- at the row/statement level regardless of role privileges.
--
-- Note on UPDATE grant: the application uses `SELECT ... FOR UPDATE` to take a
-- row lock when computing the hash chain. PostgreSQL requires the UPDATE
-- privilege for that lock clause, so audit_w needs UPDATE granted on the
-- table. The triggers below ensure no actual mutation succeeds.

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

-- Immutability enforcement: refuse any UPDATE, DELETE, or TRUNCATE on
-- audit_events. SELECT ... FOR UPDATE only takes a row lock and does not
-- invoke the BEFORE UPDATE trigger, so the hash-chain locking path in
-- audit-service.ts continues to work.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only — % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    EXECUTE FUNCTION audit_events_immutable();

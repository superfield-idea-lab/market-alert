-- dev-postgres-init/01-agent-roles.sql
--
-- Creates the agent_worker base role and per-type agent roles for local
-- development.  These roles are created by init-remote.ts in production;
-- for dev they are bootstrapped directly via postgres init scripts so the
-- worker container can authenticate without a full remote-init run.
--
-- Template-only roles (agent_coding, agent_analysis, agent_code_cleanup)
-- were removed in issue #214.  Only PRD-required worker agents are provisioned.
--
-- The agent_email_ingest role gets:
--   - LOGIN with a known dev password
--   - CONNECT on calypso_app
--   - USAGE on public schema
--   - SELECT on task_queue_view_email_ingest only (no INSERT/UPDATE/DELETE)
--
-- RLS is NOT configured here because schema.sql (run by migrate()) creates
-- the views with WHERE agent_type = '...' filters that already restrict rows.
-- The view-level filter is sufficient for local development isolation.
--
-- This script is idempotent: all statements use IF NOT EXISTS / DO...END guards.

-- Base group role for all agent workers
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agent_worker') THEN
    CREATE ROLE agent_worker NOLOGIN;
  END IF;
END
$$;

-- Per-type email_ingest agent role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agent_email_ingest') THEN
    CREATE ROLE agent_email_ingest WITH LOGIN PASSWORD 'agent_email_ingest_dev_password' IN ROLE agent_worker;
  ELSE
    ALTER ROLE agent_email_ingest WITH LOGIN PASSWORD 'agent_email_ingest_dev_password';
  END IF;
END
$$;

-- Grant CONNECT on the app database to the email_ingest agent role
GRANT CONNECT ON DATABASE calypso_app TO agent_email_ingest;

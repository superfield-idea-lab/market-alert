/**
 * Worker database pool — read-only agent-type credentials.
 *
 * Workers connect using their type-specific role (`agent_<type>`) which has
 * SELECT-only access on the per-type task queue view. The role is created by
 * `init-remote.ts` during genesis DB init and explicitly denied INSERT, UPDATE,
 * DELETE via the `agent_worker` base role.
 *
 * Phase 1 (Linkerd mTLS and machine tokens): the worker package must not carry
 * a direct `postgres` dependency. The `createAgentPool` factory exported by the
 * `db` workspace package is the approved way for workers to obtain a pool.
 * This keeps `apps/worker/package.json` free of postgres/pg entries, which is
 * enforced by the CI check in `scripts/ci/check-worker-no-db-deps.sh`.
 *
 * Canonical docs:
 *   - docs/plan.md (Phase 1: Linkerd mTLS service mesh and machine tokens)
 *   - apps/worker/src/startup-guard.ts (credential guard)
 *   - packages/db/index.ts (createAgentPool factory)
 *   - k8s/worker-network-policy.yaml (network-layer egress block on 5432)
 *
 * Environment:
 *   AGENT_DATABASE_URL — connection string for the agent-type role
 *   AGENT_TYPE         — agent type name (e.g. "coding", "analysis")
 */

import { createAgentPool as _createAgentPool } from 'db';

export { createAgentPool } from 'db';

export interface AgentDbConfig {
  agentDatabaseUrl: string;
  agentType: string;
}

export function loadAgentDbConfig(env: NodeJS.ProcessEnv = process.env): AgentDbConfig {
  const missing = ['AGENT_DATABASE_URL', 'AGENT_TYPE'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    agentDatabaseUrl: env.AGENT_DATABASE_URL!,
    agentType: env.AGENT_TYPE!,
  };
}

// Re-export the type so callers can reference it without importing from 'db'.
export type AgentPool = ReturnType<typeof _createAgentPool>;

/**
 * Worker startup role verification.
 *
 * Blueprint reference: TQ-C-008 `startup-role-verification-tested`
 *
 * On startup, the worker queries whether the currently connected database role
 * has INSERT privilege on the `task_queue` table. If it does, the worker logs
 * an error and calls `process.exit(1)` — it refuses to start with a write-capable
 * role. This ensures that even a misconfigured deployment fails loudly rather than
 * silently operating with excessive DB privileges.
 *
 * A read-only agent role must never have INSERT on task_queue. If this check fires,
 * it means the wrong credentials were injected into AGENT_DATABASE_URL.
 *
 * Phase 2 addition (issue #14):
 *
 * `assertNoDatabaseUrl` — guards against DATABASE_URL being set in the worker
 * environment. Workers must never hold the privileged app database URL; they use
 * the read-only AGENT_DATABASE_URL only. If DATABASE_URL is present the worker
 * refuses to start (acceptance criterion: "Worker holds no DATABASE_URL:
 * startup-guard passes").
 *
 * Blueprint ref: WORKER-T-002 (no privileged DB access from worker process).
 */

export interface VerifyResult {
  canInsert: boolean;
}

export async function verifyReadOnlyRole(db: {
  unsafe: (sql: string) => Promise<{ can_insert: boolean }[]>;
}): Promise<VerifyResult> {
  const rows = await db.unsafe(
    `SELECT has_table_privilege(current_user, 'task_queue', 'INSERT') AS can_insert`,
  );
  return { canInsert: rows[0]?.can_insert ?? false };
}

export async function assertReadOnlyRole(
  db: { unsafe: (sql: string) => Promise<{ can_insert: boolean }[]> },
  logger: { error: (msg: string) => void } = console,
): Promise<void> {
  const { canInsert } = await verifyReadOnlyRole(db);
  if (canInsert) {
    logger.error(
      'Worker DB role has INSERT on task_queue — refusing to start. ' +
        'Check AGENT_DATABASE_URL and ensure it uses a read-only agent role.',
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// DATABASE_URL absence guard (Phase 2, issue #14)
// ---------------------------------------------------------------------------

/**
 * Asserts that the DATABASE_URL environment variable is NOT set.
 *
 * Workers must hold no privileged database URL — they communicate exclusively
 * through the internal API using a delegated WORKER_TOKEN (WORKER-T-002).
 *
 * If DATABASE_URL is present, this function logs an error and exits with
 * code 1. This satisfies the acceptance criterion:
 *   "Worker holds no DATABASE_URL: startup-guard passes"
 *
 * @param env     Optional environment object for testing (defaults to process.env).
 * @param logger  Optional logger (defaults to console).
 */
export function assertNoDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  logger: { error: (msg: string) => void } = console,
): void {
  if (env['DATABASE_URL']) {
    logger.error(
      'Worker must not have DATABASE_URL set — refusing to start. ' +
        'DATABASE_URL is reserved for the app server; workers use AGENT_DATABASE_URL only. ' +
        '(WORKER-T-002, issue #14)',
    );
    process.exit(1);
  }
}

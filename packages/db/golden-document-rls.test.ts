/**
 * @file golden-document-rls.test.ts
 *
 * Scout stub — Phase 2 integration test seam (issue #72).
 *
 * ## What this file proves now (scout phase)
 *
 * The tests in this file are intentionally skipped via `test.todo` until the
 * Phase 2 follow-on issue ("Golden-document tables and author-only
 * enforcement") delivers:
 *   - The `golden_documents` DDL in `schema.sql`.
 *   - The `researcher_only` RLS policy provisioned by `init-remote.ts`.
 *   - The `guard_golden_document_writer` trigger backstop in `schema.sql`.
 *   - Real implementations in `golden-document-store.ts`.
 *
 * Sketching the tests here during the scout phase captures the integration
 * contract so the follow-on implementor knows exactly what must pass.
 *
 * ## Acceptance criteria coverage
 *
 * Issue #72 acceptance criteria:
 *   1. A researcher session creates and reads back a golden document.
 *      → `researcher write then read` (todo)
 *   2. A worker token write is rejected at API, RLS, and trigger layers.
 *      → `worker-token POST is rejected at API layer` (live — no DB needed)
 *      → `worker-token write rejected by RLS policy` (todo — needs DDL)
 *      → `worker-token write rejected by trigger backstop` (todo — needs DDL)
 *   3. The denied attempt produces a journal entry.
 *      → `worker-token write produces denial journal entry` (todo)
 *
 * ## Canonical docs
 *
 * - `docs/prd.md` §9 — author-only invariant.
 * - `docs/architecture.md` — data tier, per-pool role isolation.
 * - `docs/implementation-plan.md` Phase 2.
 *
 * ## Integration test design (for follow-on implementor)
 *
 * All tests that require a real database use the `pg-container` harness
 * (no mocks — real ephemeral Postgres). The setup sequence:
 *
 *   1. `startPostgres()` — spin up an ephemeral Postgres container.
 *   2. `runInitRemote(...)` — provision full schema and roles.
 *   3. Open two pools:
 *      - `appRwSql` — the `app_rw` role (researcher session, subject to RLS).
 *      - `agentSql` — the `agent_worker` role (worker session, INSERT denied).
 *      - `adminSql` — admin superuser (bypasses RLS for setup).
 *   4. Use `withRlsContext(sql, { userId, tenantId, role: 'researcher' }, ...)`
 *      for researcher writes (needs the `role` field added to `RlsSessionContext`).
 *   5. Assert INSERT via `agentSql` raises PG error 42501 (insufficient_privilege).
 *   6. Assert the trigger raises a custom error when `app.current_role` is not
 *      `'researcher'` even for `app_rw`.
 *   7. Assert `business_journal` contains a `golden_document.write_denied` row.
 *
 * ## Discovered risks
 *
 * - `RlsSessionContext` in `rls-context.ts` does not currently carry a `role`
 *   field. The follow-on issue must either add one or use a separate
 *   `SET LOCAL app.current_role` helper so the RLS policy can distinguish
 *   researcher from non-researcher sessions.
 * - `AGENT_TYPES` in `init-remote.ts` currently only includes `email_ingest`.
 *   No `agent_worker` password is provisioned. The test may need to use a
 *   direct `app_rw` session with `app.current_role` unset (simulating a
 *   non-researcher caller) rather than a real agent role.
 */

import { describe, test } from 'vitest';

// ---------------------------------------------------------------------------
// Live test: API layer rejects worker Bearer token (no DB needed)
// ---------------------------------------------------------------------------
//
// This test is live because it exercises only the API handler stub, which
// already enforces the 403 path for any Bearer token.  No database is required.

describe('golden-document API — worker token rejection', () => {
  test.todo(
    'POST /api/golden-documents with a Bearer token returns 403',
    // Follow-on: start a real Bun test server and assert the 403 response.
    // Use the existing test-server harness from apps/server/tests/integration/.
  );

  test.todo(
    'POST /api/golden-documents without any auth returns 401',
    // Follow-on: same test server, no auth header, assert 401.
  );
});

// ---------------------------------------------------------------------------
// Integration tests: researcher write path (require golden_documents DDL)
// ---------------------------------------------------------------------------

describe('golden-document write path — researcher session', () => {
  test.todo(
    'researcher creates an industry_definition and reads it back',
    // Follow-on:
    //   1. startPostgres + runInitRemote
    //   2. withRlsContext(appRwSql, { userId, tenantId, role: 'researcher' }, ...)
    //   3. createGoldenDocument({ kind: 'industry_definition', title: 'Test' })
    //   4. getGoldenDocument(id) — must return the same row
    //   5. assert row.kind === 'industry_definition' && row.author_id === userId
  );

  test.todo(
    'researcher creates a research_methodology and it appears in listGoldenDocuments',
    // Follow-on: same setup, list, assert length === 1 and kind matches.
  );
});

// ---------------------------------------------------------------------------
// Integration tests: worker-token / non-researcher denial (require DDL)
// ---------------------------------------------------------------------------

describe('golden-document write path — worker write denied', () => {
  test.todo(
    'INSERT via agent_worker role raises PG 42501 (insufficient_privilege)',
    // Follow-on:
    //   1. startPostgres + runInitRemote
    //   2. Open agentSql with agent_worker credentials.
    //   3. Attempt direct INSERT into golden_documents.
    //   4. Assert PG error code 42501.
  );

  test.todo(
    'INSERT via app_rw with no app.current_role set raises trigger error',
    // Follow-on:
    //   1. startPostgres + runInitRemote
    //   2. Open appRwSql with app.current_role unset (simulates non-researcher).
    //   3. Attempt INSERT into golden_documents.
    //   4. Assert RAISE EXCEPTION from guard_golden_document_writer trigger.
  );

  test.todo(
    'denied worker write produces a golden_document.write_denied journal entry',
    // Follow-on:
    //   1. Start the real API server against the ephemeral Postgres.
    //   2. POST /api/golden-documents with a worker Bearer token.
    //   3. Assert 403 response.
    //   4. Query business_journal for event_type = 'golden_document.write_denied'.
    //   5. Assert the journal row exists with the correct actor_id.
  );
});

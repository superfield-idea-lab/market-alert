/**
 * Integration test stubs — security vertical slice (dev-scout).
 *
 * This file contains skeleton test cases that will be filled in by the Phase 1
 * follow-on implementation issue. Each `test.todo` documents one acceptance
 * criterion or test-plan item from issue #13 so the follow-on author knows
 * exactly what to prove.
 *
 * No real assertions are made here. The file must remain importable and must
 * pass `bun test --dry-run` without errors.
 *
 * Acceptance criteria to prove (issue #13):
 *   AC-1  A passkey-authenticated session reads the test entity via an RLS-scoped query
 *   AC-2  A different authenticated session cannot read the first session's row
 *   AC-3  Every read produces an audit event written before the read commits
 *   AC-4  A forced audit write failure denies the read
 *   AC-5  The sensitive column is stored encrypted and decrypted on read
 *
 * Test-plan items (issue #13):
 *   TP-1  Integration: real passkey login flow → RLS-scoped read → audit event → encrypted-column round trip
 *   TP-2  Integration: second identity attempts to read the first identity's row and is denied
 *   TP-3  Integration: simulate audit store failure and assert the read is denied
 */

import { test } from 'vitest';

// ---------------------------------------------------------------------------
// AC-1 + TP-1: passkey login → RLS read → audit event → encrypted round trip
// ---------------------------------------------------------------------------

test.todo(
  'passkey-authenticated session reads own test entity via RLS-scoped query and receives decrypted sensitive column',
);

test.todo(
  'the read path emits an audit event that is durable before the SELECT result is returned',
);

test.todo('sensitive column stored under AES-256-GCM is transparently decrypted on the read path');

// ---------------------------------------------------------------------------
// AC-2 + TP-2: identity isolation enforced at the database layer
// ---------------------------------------------------------------------------

test.todo(
  "second authenticated session cannot read the first identity's entity row — blocked by Postgres RLS",
);

// ---------------------------------------------------------------------------
// AC-4 + TP-3: audit-failure denies the read
// ---------------------------------------------------------------------------

test.todo(
  'when the audit store write fails the entity read is denied and no data is returned to the caller',
);

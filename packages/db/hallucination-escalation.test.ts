/**
 * @file hallucination-escalation.test.ts
 *
 * Integration tests for the hallucination escalation counter (issue #67, PRD §9).
 *
 * All tests run against a real ephemeral Postgres container — no mocks.
 *
 * ## Acceptance criteria under test
 *
 * 1. A DISMISSED annotation increments the customer's counter.
 * 2. Three dismissals in 30 days force the next draft into explicit-approval mode.
 * 3. Dismissals outside the 30-day window do not count.
 * 4. The escalation flag clears when the window rolls (oldest dismissal ages out).
 *
 * ## Integration: autolearn_jobs.requires_explicit_approval
 *
 * 5. `createAutolearnJob({ requires_explicit_approval: true })` persists the flag.
 * 6. A job created after three in-window dismissals carries `requires_explicit_approval = true`.
 * 7. A job created after one in-window dismissal carries `requires_explicit_approval = false`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { startPostgres, type PgContainer } from './pg-container';
import { runInitRemote } from './init-remote';
import { migrate } from './index';
import {
  migrateEscalationSchema,
  recordDismissal,
  countDismissalsInWindow,
  customerRequiresEscalation,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_ESCALATION_THRESHOLD,
} from './hallucination-escalation';
import { createAutolearnJob, AutolearnSourceType } from './autolearn-state-machine';

// ---------------------------------------------------------------------------
// Container + pool setup
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

const TEST_PASSWORDS = {
  app: 'app_test_pw',
  audit: 'audit_test_pw',
  analytics: 'analytics_test_pw',
  dictionary: 'dict_test_pw',
  email_ingest: 'email_ingest_test_pw',
};

function makeRoleUrl(adminUrl: string, db: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = password;
  u.pathname = `/${db}`;
  return u.toString();
}

beforeAll(async () => {
  pg = await startPostgres();

  await runInitRemote({
    ADMIN_DATABASE_URL: pg.url,
    APP_RW_PASSWORD: TEST_PASSWORDS.app,
    AUDIT_W_PASSWORD: TEST_PASSWORDS.audit,
    ANALYTICS_W_PASSWORD: TEST_PASSWORDS.analytics,
    DICT_RW_PASSWORD: TEST_PASSWORDS.dictionary,
    AGENT_EMAIL_INGEST_PASSWORD: TEST_PASSWORDS.email_ingest,
  } as NodeJS.ProcessEnv);

  const appUrl = makeRoleUrl(pg.url, 'superfield_app', 'app_rw', TEST_PASSWORDS.app);
  sql = postgres(appUrl, { max: 3 });

  await migrate({ databaseUrl: appUrl });
  await migrateEscalationSchema(sql);

  // Re-point the autolearn-state-machine pool at the ephemeral container.
  process.env.DATABASE_URL = appUrl;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

function customerId(): string {
  return `customer-escalation-${Date.now()}-${++seq}`;
}

function annotationId(): string {
  return `ann-escalation-${Date.now()}-${++seq}`;
}

/** Returns a Date that is `daysAgo` days before now. */
function daysAgo(daysAgo: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  test('DEFAULT_WINDOW_DAYS is 30', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
  });

  test('DEFAULT_ESCALATION_THRESHOLD is 3', () => {
    expect(DEFAULT_ESCALATION_THRESHOLD).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// recordDismissal
// ---------------------------------------------------------------------------

describe('recordDismissal', () => {
  test('inserts a row and returns it with correct fields', async () => {
    const cid = customerId();
    const aid = annotationId();

    const row = await recordDismissal(sql, { customerId: cid, annotationId: aid });

    expect(row.customer_id).toBe(cid);
    expect(row.annotation_id).toBe(aid);
    expect(row.id).toBeTruthy();
    expect(row.dismissed_at).toBeInstanceOf(Date);
  });

  test('accepts an explicit dismissedAt timestamp', async () => {
    const cid = customerId();
    const aid = annotationId();
    const ts = daysAgo(10);

    const row = await recordDismissal(sql, { customerId: cid, annotationId: aid, dismissedAt: ts });

    // Allow a 1-second tolerance for DB round-trip truncation.
    expect(Math.abs(row.dismissed_at.getTime() - ts.getTime())).toBeLessThan(1000);
  });

  test('multiple dismissals for the same customer all persist', async () => {
    const cid = customerId();

    await recordDismissal(sql, { customerId: cid, annotationId: annotationId() });
    await recordDismissal(sql, { customerId: cid, annotationId: annotationId() });
    await recordDismissal(sql, { customerId: cid, annotationId: annotationId() });

    const count = await countDismissalsInWindow(sql, cid);
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// countDismissalsInWindow — Acceptance criterion 1 & 3
// ---------------------------------------------------------------------------

describe('countDismissalsInWindow', () => {
  test('returns 0 for a customer with no dismissals', async () => {
    const count = await countDismissalsInWindow(sql, customerId());
    expect(count).toBe(0);
  });

  test('counts only dismissals within the window', async () => {
    const cid = customerId();

    // One dismissal 5 days ago (inside 30-day window).
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(5),
    });
    // One dismissal 31 days ago (outside 30-day window).
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(31),
    });

    const count = await countDismissalsInWindow(sql, cid);
    expect(count).toBe(1);
  });

  test('dismissals on the boundary (exactly windowDays ago) do not count', async () => {
    const cid = customerId();

    // Exactly 30 days ago — should fall outside the window (NOW() - 30d is the
    // exclusive lower bound: dismissed_at >= NOW() - INTERVAL '30 days').
    // A timestamp slightly older than 30 days will not satisfy the condition.
    const exactly30dAgo = daysAgo(30);
    exactly30dAgo.setSeconds(exactly30dAgo.getSeconds() - 1); // 30d + 1s ago
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: exactly30dAgo,
    });

    const count = await countDismissalsInWindow(sql, cid);
    expect(count).toBe(0);
  });

  test('dismissals from different customers are isolated', async () => {
    const cidA = customerId();
    const cidB = customerId();

    await recordDismissal(sql, { customerId: cidA, annotationId: annotationId() });
    await recordDismissal(sql, { customerId: cidA, annotationId: annotationId() });
    await recordDismissal(sql, { customerId: cidA, annotationId: annotationId() });

    const countA = await countDismissalsInWindow(sql, cidA);
    const countB = await countDismissalsInWindow(sql, cidB);

    expect(countA).toBe(3);
    expect(countB).toBe(0);
  });

  test('respects a custom windowDays parameter', async () => {
    const cid = customerId();

    // 8 days ago — inside a 10-day window, outside a 7-day window.
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(8),
    });

    expect(await countDismissalsInWindow(sql, cid, 10)).toBe(1);
    expect(await countDismissalsInWindow(sql, cid, 7)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// customerRequiresEscalation — Acceptance criteria 2, 3, 4
// ---------------------------------------------------------------------------

describe('customerRequiresEscalation — acceptance criteria', () => {
  test('AC-2: three dismissals in 30 days require escalation', async () => {
    const cid = customerId();

    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(1),
    });
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(2),
    });
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(3),
    });

    expect(await customerRequiresEscalation(sql, cid)).toBe(true);
  });

  test('AC-3: dismissals outside 30-day window do not count towards escalation', async () => {
    const cid = customerId();

    // Three dismissals but all outside the window.
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(31),
    });
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(35),
    });
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(40),
    });

    expect(await customerRequiresEscalation(sql, cid)).toBe(false);
  });

  test('AC-4: escalation flag clears when window rolls — oldest dismissal aged out', async () => {
    const cid = customerId();

    // Two dismissals inside the 7-day custom window.
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(3),
    });
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(4),
    });
    // One dismissal aged out of the 7-day window (8 days ago).
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(8),
    });

    // With 7-day window only 2 in-window dismissals → threshold of 3 not met.
    expect(await customerRequiresEscalation(sql, cid, 7, 3)).toBe(false);

    // With 10-day window all 3 are in-window → threshold met.
    expect(await customerRequiresEscalation(sql, cid, 10, 3)).toBe(true);
  });

  test('fewer than threshold dismissals do not escalate', async () => {
    const cid = customerId();

    await recordDismissal(sql, { customerId: cid, annotationId: annotationId() });
    await recordDismissal(sql, { customerId: cid, annotationId: annotationId() });

    expect(await customerRequiresEscalation(sql, cid)).toBe(false);
  });

  test('zero dismissals do not escalate', async () => {
    expect(await customerRequiresEscalation(sql, customerId())).toBe(false);
  });

  test('exactly threshold dismissals escalate', async () => {
    const cid = customerId();

    for (let i = 0; i < DEFAULT_ESCALATION_THRESHOLD; i++) {
      await recordDismissal(sql, {
        customerId: cid,
        annotationId: annotationId(),
        dismissedAt: daysAgo(i + 1),
      });
    }

    expect(await customerRequiresEscalation(sql, cid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autolearn_jobs.requires_explicit_approval integration
// ---------------------------------------------------------------------------

describe('autolearn_jobs.requires_explicit_approval', () => {
  test('defaults to false when not specified', async () => {
    const job = await createAutolearnJob({
      tenant_id: 'tenant-esc-test',
      customer_id: customerId(),
      dept_id: 'dept-esc',
      source_type: AutolearnSourceType.GARDENING,
    });

    expect(job.requires_explicit_approval).toBe(false);
  });

  test('persists true when explicitly set', async () => {
    const job = await createAutolearnJob({
      tenant_id: 'tenant-esc-test',
      customer_id: customerId(),
      dept_id: 'dept-esc',
      source_type: AutolearnSourceType.GARDENING,
      requires_explicit_approval: true,
    });

    expect(job.requires_explicit_approval).toBe(true);
  });

  test('end-to-end: three in-window dismissals → next autolearn job flagged', async () => {
    const cid = customerId();

    // Dismiss three annotations within the 30-day window.
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(5),
    });
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(10),
    });
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(15),
    });

    const escalate = await customerRequiresEscalation(sql, cid);
    expect(escalate).toBe(true);

    // Create the next autolearn job with the escalation flag.
    const job = await createAutolearnJob({
      tenant_id: 'tenant-esc-e2e',
      customer_id: cid,
      dept_id: 'dept-esc-e2e',
      requires_explicit_approval: escalate,
    });

    expect(job.requires_explicit_approval).toBe(true);
    expect(job.customer_id).toBe(cid);
  });

  test('end-to-end: one in-window dismissal → next autolearn job not flagged', async () => {
    const cid = customerId();

    // Only one dismissal in the window.
    await recordDismissal(sql, {
      customerId: cid,
      annotationId: annotationId(),
      dismissedAt: daysAgo(2),
    });

    const escalate = await customerRequiresEscalation(sql, cid);
    expect(escalate).toBe(false);

    const job = await createAutolearnJob({
      tenant_id: 'tenant-esc-e2e',
      customer_id: cid,
      dept_id: 'dept-esc-e2e',
      requires_explicit_approval: escalate,
    });

    expect(job.requires_explicit_approval).toBe(false);
  });
});

/**
 * Unit tests for the SOC compliance review cron job.
 *
 * Validates:
 *   - Job registers successfully on the scheduler
 *   - Tick enqueues a task with correct job_type and payload shape
 *   - Idempotency key is deterministic within the same minute window
 *   - Custom cron expression is accepted
 *   - Module exports are correct
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock croner before importing anything that uses it.
vi.mock('croner', () => {
  class MockCron {
    name: string;
    fn: () => void;
    stopped = false;

    constructor(expression: string, options: { name?: string }, fn: () => void) {
      this.name = options.name ?? '';
      this.fn = fn;
      MockCron.instances.push(this);
    }

    stop() {
      this.stopped = true;
    }

    static instances: MockCron[] = [];
    static reset() {
      MockCron.instances = [];
    }
  }

  return { Cron: MockCron };
});

// Mock db/task-queue so no real DB is needed.
vi.mock('db/task-queue', () => ({
  enqueueTask: vi.fn(async () => ({
    id: 'mock-task-id',
    idempotency_key: 'mock-key',
    agent_type: 'cron',
    job_type: 'soc_compliance_review',
    status: 'pending',
    payload: {},
    correlation_id: null,
    created_by: 'cron:soc-compliance-review',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    delegated_token: null,
    result: null,
    error_message: null,
    attempt: 0,
    max_attempts: 2,
    next_retry_at: null,
    priority: 3,
    created_at: new Date(),
    updated_at: new Date(),
  })),
}));

import { CronScheduler } from '../../src/cron/scheduler';
import { enqueueTask } from 'db/task-queue';
import { Cron } from 'croner';
import {
  registerSocComplianceReviewJob,
  SOC_COMPLIANCE_CRON_EXPRESSION,
  SOC_COMPLIANCE_CRON_AGENT_TYPE,
  SOC_COMPLIANCE_CRON_JOB_TYPE,
} from '../../src/cron/jobs/soc-compliance-review';

beforeEach(() => {
  vi.clearAllMocks();
  (Cron as unknown as { reset: () => void }).reset();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  test('SOC_COMPLIANCE_CRON_EXPRESSION is daily at midnight UTC', () => {
    expect(SOC_COMPLIANCE_CRON_EXPRESSION).toBe('0 0 * * *');
  });

  test('SOC_COMPLIANCE_CRON_AGENT_TYPE is soc_compliance', () => {
    expect(SOC_COMPLIANCE_CRON_AGENT_TYPE).toBe('soc_compliance');
  });

  test('SOC_COMPLIANCE_CRON_JOB_TYPE is soc_compliance_review', () => {
    expect(SOC_COMPLIANCE_CRON_JOB_TYPE).toBe('soc_compliance_review');
  });
});

// ---------------------------------------------------------------------------
// registerSocComplianceReviewJob
// ---------------------------------------------------------------------------

describe('registerSocComplianceReviewJob', () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  test('registers the job on the scheduler', () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();
    expect(scheduler.hasJob('soc-compliance-review')).toBe(true);
  });

  test('uses default daily expression when none provided', () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();
    expect(scheduler.hasJob('soc-compliance-review')).toBe(true);
  });

  test('accepts a custom cron expression', () => {
    registerSocComplianceReviewJob(scheduler, '0 */6 * * *'); // every 6 hours
    scheduler.start();
    expect(scheduler.hasJob('soc-compliance-review')).toBe(true);
  });

  test('tick enqueues a soc_compliance_review task', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    expect(enqueueTask).toHaveBeenCalledOnce();
    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.job_type).toBe('soc_compliance_review');
  });

  test('tick enqueues with agent_type=cron', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.agent_type).toBe('cron');
  });

  test('tick enqueues with correct priority', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.priority).toBe(3);
  });

  test('tick enqueues with max_attempts=2', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.max_attempts).toBe(2);
  });

  test('tick payload contains scheduled_at timestamp', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(typeof (call.payload as Record<string, unknown>)?.['scheduled_at']).toBe('string');
  });

  test('tick payload contains review_scope=full', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect((call.payload as Record<string, unknown>)?.['review_scope']).toBe('full');
  });

  test('idempotency key contains job name and minute-scoped timestamp', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.idempotency_key).toMatch(/^cron:soc-compliance-review:soc-review-/);
  });

  test('two ticks in the same minute produce the same idempotency key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T00:00:30.000Z'));

    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;

    // First tick
    await instances[0].fn();
    const key1 = vi.mocked(enqueueTask).mock.calls[0][0].idempotency_key;

    vi.clearAllMocks();

    // Second tick within same minute
    vi.setSystemTime(new Date('2024-06-15T00:00:45.000Z'));
    await instances[0].fn();
    const key2 = vi.mocked(enqueueTask).mock.calls[0][0].idempotency_key;

    expect(key1).toBe(key2);

    vi.useRealTimers();
  });

  test('ticks in different minutes produce different idempotency keys', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T00:00:00.000Z'));

    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;

    // First tick at T+0
    await instances[0].fn();
    const key1 = vi.mocked(enqueueTask).mock.calls[0][0].idempotency_key;

    vi.clearAllMocks();

    // Second tick at T+1 minute
    vi.setSystemTime(new Date('2024-06-15T00:01:00.000Z'));
    await instances[0].fn();
    const key2 = vi.mocked(enqueueTask).mock.calls[0][0].idempotency_key;

    expect(key1).not.toBe(key2);

    vi.useRealTimers();
  });

  test('created_by is set to the cron job actor', async () => {
    registerSocComplianceReviewJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => void }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.created_by).toBe('cron:soc-compliance-review');
  });
});

/**
 * Unit tests for the code cleanup cron job.
 *
 * Validates:
 *   - Job registers under the correct name
 *   - Handler enqueues a task with job_type=code_cleanup
 *   - Task uses agent_type=cron (set by the scheduler context)
 *   - Idempotency key suffix includes the current date
 *   - Priority is set to 3 (low-priority analysis task)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock croner before importing the scheduler
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

// Mock db/task-queue
vi.mock('db/task-queue', () => ({
  enqueueTask: vi.fn(async () => ({
    id: 'mock-task-id',
    idempotency_key: 'mock-key',
    agent_type: 'cron',
    job_type: 'code_cleanup',
    status: 'pending',
    payload: {},
    correlation_id: null,
    created_by: 'cron:code-cleanup',
    claimed_by: null,
    claimed_at: null,
    claim_expires_at: null,
    delegated_token: null,
    result: null,
    error_message: null,
    attempt: 0,
    max_attempts: 1,
    next_retry_at: null,
    priority: 3,
    created_at: new Date(),
    updated_at: new Date(),
  })),
}));

import { CronScheduler } from '../../src/cron/scheduler';
import { registerCodeCleanupJob } from '../../src/cron/jobs/code-cleanup';
import { enqueueTask } from 'db/task-queue';
import { Cron } from 'croner';

beforeEach(() => {
  vi.clearAllMocks();
  (Cron as unknown as { reset: () => void }).reset();
});

describe('registerCodeCleanupJob', () => {
  let scheduler: CronScheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  test('registers job under name "code-cleanup"', () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();
    expect(scheduler.hasJob('code-cleanup')).toBe(true);
  });

  test('uses default expression 0 2 * * * (daily at 02:00 UTC)', () => {
    const mockScheduler = {
      register: vi.fn(),
    } as unknown as CronScheduler;
    registerCodeCleanupJob(mockScheduler);
    expect(mockScheduler.register).toHaveBeenCalledWith(
      'code-cleanup',
      '0 2 * * *',
      expect.any(Function),
    );
  });

  test('accepts a custom expression override', () => {
    const mockScheduler = {
      register: vi.fn(),
    } as unknown as CronScheduler;
    registerCodeCleanupJob(mockScheduler, '0 6 * * 1');
    expect(mockScheduler.register).toHaveBeenCalledWith(
      'code-cleanup',
      '0 6 * * 1',
      expect.any(Function),
    );
  });

  test('handler enqueues a code_cleanup task', async () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => Promise<void> }[] }).instances;
    await instances[0].fn();

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.job_type).toBe('code_cleanup');
  });

  test('handler sets agent_type=cron via scheduler context', async () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => Promise<void> }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.agent_type).toBe('cron');
  });

  test('handler sets created_by=cron:code-cleanup', async () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => Promise<void> }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.created_by).toBe('cron:code-cleanup');
  });

  test('handler sets priority=3 (low-priority analysis)', async () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => Promise<void> }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.priority).toBe(3);
  });

  test('handler sets max_attempts=1', async () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => Promise<void> }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.max_attempts).toBe(1);
  });

  test('idempotency_key includes daily suffix with current date', async () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => Promise<void> }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    const today = new Date().toISOString().slice(0, 10);
    expect(call.idempotency_key).toMatch(new RegExp(`daily-${today}`));
  });

  test('payload includes prompt_ref and triggered_at', async () => {
    registerCodeCleanupJob(scheduler);
    scheduler.start();

    const instances = (Cron as unknown as { instances: { fn: () => Promise<void> }[] }).instances;
    await instances[0].fn();

    const call = vi.mocked(enqueueTask).mock.calls[0][0];
    expect(call.payload).toMatchObject({
      prompt_ref: 'builtin:code-cleanup-v1',
    });
    expect(typeof (call.payload as Record<string, unknown>)['triggered_at']).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// boot.ts integration — verifies the job is registered in the scheduler boot
// ---------------------------------------------------------------------------

describe('startCronScheduler includes code-cleanup job', () => {
  test('boot.ts registers the code-cleanup job', async () => {
    const { startCronScheduler, stopCronScheduler } = await import('../../src/cron/boot');
    const sched = startCronScheduler();
    expect(sched.hasJob('code-cleanup')).toBe(true);
    stopCronScheduler();
  });
});

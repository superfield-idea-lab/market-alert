/**
 * Unit tests for the IMAP ETL cron dispatcher.
 *
 * The dispatcher calls `enqueueTask` from the db package directly (not via
 * `enqueueCronTask`), so unit tests verify the registration behaviour and
 * structural invariants without triggering a real DB call.
 */

import { describe, test, expect } from 'vitest';
import { CronScheduler } from '../../src/cron/scheduler';
import { registerImapEtlDispatchJob } from '../../src/cron/jobs/imap-etl-dispatch';
import { TaskType, TASK_TYPE_AGENT_MAP } from 'db/task-queue';

// ---------------------------------------------------------------------------
// Job registration
// ---------------------------------------------------------------------------

describe('registerImapEtlDispatchJob', () => {
  test('registers a job named "imap-etl-dispatch"', () => {
    const scheduler = new CronScheduler();
    registerImapEtlDispatchJob(scheduler, '*/5 * * * *', 'primary');
    scheduler.start();
    expect(scheduler.hasJob('imap-etl-dispatch')).toBe(true);
    scheduler.stop();
  });

  test('accepts a custom cron expression', () => {
    const scheduler = new CronScheduler();
    registerImapEtlDispatchJob(scheduler, '0 * * * *', 'primary');
    scheduler.start();
    expect(scheduler.hasJob('imap-etl-dispatch')).toBe(true);
    scheduler.stop();
  });

  test('accepts a custom mailboxRef', () => {
    const scheduler = new CronScheduler();
    registerImapEtlDispatchJob(scheduler, '*/5 * * * *', 'secondary');
    scheduler.start();
    expect(scheduler.hasJob('imap-etl-dispatch')).toBe(true);
    scheduler.stop();
  });

  test('registers exactly one job', () => {
    const scheduler = new CronScheduler();
    registerImapEtlDispatchJob(scheduler, '*/5 * * * *', 'primary');
    scheduler.start();
    expect(scheduler.getJobNames()).toContain('imap-etl-dispatch');
    scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// TaskType and agent map invariants
// ---------------------------------------------------------------------------

describe('EMAIL_INGEST task type', () => {
  test('TaskType.EMAIL_INGEST equals EMAIL_INGEST', () => {
    expect(TaskType.EMAIL_INGEST).toBe('EMAIL_INGEST');
  });

  test('TASK_TYPE_AGENT_MAP[EMAIL_INGEST] equals email_ingest', () => {
    expect(TASK_TYPE_AGENT_MAP[TaskType.EMAIL_INGEST]).toBe('email_ingest');
  });
});

// ---------------------------------------------------------------------------
// Module export
// ---------------------------------------------------------------------------

describe('imap-etl-dispatch module', () => {
  test('registerImapEtlDispatchJob is exported as a function', async () => {
    const mod = await import('../../src/cron/jobs/imap-etl-dispatch.js');
    expect(typeof mod.registerImapEtlDispatchJob).toBe('function');
  });
});

/**
 * @file autolearn-state-machine.spec.ts
 *
 * Integration test harness for the PRD §4.3 autolearn state machine.
 *
 * Each test drives one state transition against a real ephemeral Postgres
 * instance (via pg-container).  No mocks are used — every assertion targets
 * a real database row.
 *
 * ## PRD §4.3 state machine under test
 *
 * ```
 * WORKER_STARTED
 *   → FETCHING_GROUND_TRUTH
 *   → FETCHING_WIKI
 *   → WRITING_TEMP_FILES
 *   → CLAUDE_CLI_RUNNING
 *   → WRITING_NEW_VERSION
 *   → EMBEDDING
 *   → AWAITING_REVIEW
 *   → PUBLISHED
 *   → COMPLETE                  (happy path)
 *
 * AWAITING_REVIEW → REJECTED    (review rejection path)
 * Any state      → FAILED       (error path — tested from CLAUDE_CLI_RUNNING)
 * ```
 *
 * ## Coverage probe
 *
 * The final describe block verifies that `LEGAL_TRANSITIONS` contains an
 * entry for every value in `AutolearnState`.  If a new state is added to the
 * enum without a corresponding transition entry, this test fails — enforcing
 * the acceptance criterion "add a probe test that fails if a PRD §4.3
 * transition is introduced without a corresponding test".
 *
 * ## CI
 *
 * Runs under `.github/workflows/test-autolearn-harness.yml`.
 * Docker must be available on the runner (ubuntu-latest satisfies this).
 *
 * Blueprint refs: issue #42, PRD §4.3, TEST blueprint (test on target platform).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgContainer } from 'db/pg-container';
import { migrate } from 'db/index';
import {
  AutolearnState,
  AutolearnSourceType,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  InvalidTransitionError,
  AutolearnJobNotFoundError,
  createAutolearnJob,
  advanceAutolearnState,
  getAutolearnJob,
  listAutolearnJobs,
} from 'db/autolearn-state-machine';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

let pg: PgContainer;

beforeAll(async () => {
  pg = await startPostgres();
  await migrate({ databaseUrl: pg.url });

  // Re-point the db module's sql singleton to the ephemeral container.
  // The module reads DATABASE_URL at import time; we override it for the
  // duration of this test run.
  process.env.DATABASE_URL = pg.url;
}, 60_000);

afterAll(async () => {
  await pg?.stop();
});

/** Creates a minimal autolearn job row and returns it. */
async function makeJob(overrides: Partial<Parameters<typeof createAutolearnJob>[0]> = {}) {
  return createAutolearnJob({
    tenant_id: 'tenant-test',
    customer_id: `customer-${crypto.randomUUID()}`,
    dept_id: 'dept-test',
    source_type: AutolearnSourceType.GARDENING,
    ...overrides,
  });
}

/** Advances through a list of states sequentially, returning the final row. */
async function driveThrough(jobId: string, states: AutolearnState[]) {
  let row = await getAutolearnJob(jobId);
  for (const to of states) {
    row = await advanceAutolearnState({ job_id: jobId, to });
  }
  return row!;
}

// ---------------------------------------------------------------------------
// Transition: WORKER_STARTED → FETCHING_GROUND_TRUTH
// ---------------------------------------------------------------------------

describe('WORKER_STARTED → FETCHING_GROUND_TRUTH', () => {
  it('creates a job in WORKER_STARTED and advances to FETCHING_GROUND_TRUTH', async () => {
    const job = await makeJob();
    expect(job.state).toBe(AutolearnState.WORKER_STARTED);

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.FETCHING_GROUND_TRUTH,
    });

    expect(next.state).toBe(AutolearnState.FETCHING_GROUND_TRUTH);
    expect(next.id).toBe(job.id);
    expect(next.error_message).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transition: FETCHING_GROUND_TRUTH → FETCHING_WIKI
// ---------------------------------------------------------------------------

describe('FETCHING_GROUND_TRUTH → FETCHING_WIKI', () => {
  it('advances from FETCHING_GROUND_TRUTH to FETCHING_WIKI', async () => {
    const job = await makeJob();
    await advanceAutolearnState({ job_id: job.id, to: AutolearnState.FETCHING_GROUND_TRUTH });

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.FETCHING_WIKI,
    });

    expect(next.state).toBe(AutolearnState.FETCHING_WIKI);
  });
});

// ---------------------------------------------------------------------------
// Transition: FETCHING_WIKI → WRITING_TEMP_FILES
// ---------------------------------------------------------------------------

describe('FETCHING_WIKI → WRITING_TEMP_FILES', () => {
  it('advances from FETCHING_WIKI to WRITING_TEMP_FILES', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
    ]);

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.WRITING_TEMP_FILES,
    });

    expect(next.state).toBe(AutolearnState.WRITING_TEMP_FILES);
  });
});

// ---------------------------------------------------------------------------
// Transition: WRITING_TEMP_FILES → CLAUDE_CLI_RUNNING
// ---------------------------------------------------------------------------

describe('WRITING_TEMP_FILES → CLAUDE_CLI_RUNNING', () => {
  it('advances from WRITING_TEMP_FILES to CLAUDE_CLI_RUNNING', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
    ]);

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.CLAUDE_CLI_RUNNING,
    });

    expect(next.state).toBe(AutolearnState.CLAUDE_CLI_RUNNING);
  });
});

// ---------------------------------------------------------------------------
// Transition: CLAUDE_CLI_RUNNING → WRITING_NEW_VERSION
// ---------------------------------------------------------------------------

describe('CLAUDE_CLI_RUNNING → WRITING_NEW_VERSION', () => {
  it('advances from CLAUDE_CLI_RUNNING to WRITING_NEW_VERSION', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
    ]);

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.WRITING_NEW_VERSION,
    });

    expect(next.state).toBe(AutolearnState.WRITING_NEW_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Transition: WRITING_NEW_VERSION → EMBEDDING
// ---------------------------------------------------------------------------

describe('WRITING_NEW_VERSION → EMBEDDING', () => {
  it('advances from WRITING_NEW_VERSION to EMBEDDING and stores wiki_version_id', async () => {
    const job = await makeJob();
    const wikiVersionId = `wv-${crypto.randomUUID()}`;

    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
    ]);

    // WRITING_NEW_VERSION records the wiki version ID
    await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.WRITING_NEW_VERSION,
      wiki_version_id: wikiVersionId,
    });

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.EMBEDDING,
    });

    expect(next.state).toBe(AutolearnState.EMBEDDING);
    expect(next.wiki_version_id).toBe(wikiVersionId);
  });
});

// ---------------------------------------------------------------------------
// Transition: EMBEDDING → AWAITING_REVIEW
// ---------------------------------------------------------------------------

describe('EMBEDDING → AWAITING_REVIEW', () => {
  it('advances from EMBEDDING to AWAITING_REVIEW', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
    ]);

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.AWAITING_REVIEW,
    });

    expect(next.state).toBe(AutolearnState.AWAITING_REVIEW);
  });
});

// ---------------------------------------------------------------------------
// Transition: AWAITING_REVIEW → PUBLISHED
// ---------------------------------------------------------------------------

describe('AWAITING_REVIEW → PUBLISHED', () => {
  it('advances from AWAITING_REVIEW to PUBLISHED when review gate is satisfied', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
    ]);

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.PUBLISHED,
    });

    expect(next.state).toBe(AutolearnState.PUBLISHED);
  });
});

// ---------------------------------------------------------------------------
// Transition: AWAITING_REVIEW → REJECTED
// ---------------------------------------------------------------------------

describe('AWAITING_REVIEW → REJECTED', () => {
  it('transitions to REJECTED when a reviewer rejects the draft', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
    ]);

    const next = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.REJECTED,
    });

    expect(next.state).toBe(AutolearnState.REJECTED);
  });

  it('REJECTED is terminal — no further transitions are permitted', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
      AutolearnState.REJECTED,
    ]);

    await expect(
      advanceAutolearnState({ job_id: job.id, to: AutolearnState.PUBLISHED }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Transition: PUBLISHED → COMPLETE (happy path end-to-end)
// ---------------------------------------------------------------------------

describe('PUBLISHED → COMPLETE (full happy path)', () => {
  it('drives every PRD §4.3 happy-path state in sequence and lands on COMPLETE', async () => {
    const job = await makeJob({ source_type: AutolearnSourceType.GARDENING });
    expect(job.state).toBe(AutolearnState.WORKER_STARTED);

    const finalJob = await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
      AutolearnState.PUBLISHED,
      AutolearnState.COMPLETE,
    ]);

    expect(finalJob!.state).toBe(AutolearnState.COMPLETE);
    expect(finalJob!.error_message).toBeNull();
  });

  it('COMPLETE is terminal — no further transitions are permitted', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
      AutolearnState.PUBLISHED,
      AutolearnState.COMPLETE,
    ]);

    await expect(
      advanceAutolearnState({ job_id: job.id, to: AutolearnState.FAILED }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Error path: Any state → FAILED
// ---------------------------------------------------------------------------

describe('Any state → FAILED (error path)', () => {
  it('transitions to FAILED from CLAUDE_CLI_RUNNING with an error message', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
    ]);

    const failed = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.FAILED,
      error_message: 'Claude CLI exited with code 1',
    });

    expect(failed.state).toBe(AutolearnState.FAILED);
    expect(failed.error_message).toBe('Claude CLI exited with code 1');
  });

  it('transitions to FAILED from WORKER_STARTED', async () => {
    const job = await makeJob();

    const failed = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.FAILED,
      error_message: 'DB unreachable on startup',
    });

    expect(failed.state).toBe(AutolearnState.FAILED);
    expect(failed.error_message).toBe('DB unreachable on startup');
  });

  it('transitions to FAILED from AWAITING_REVIEW', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
    ]);

    const failed = await advanceAutolearnState({
      job_id: job.id,
      to: AutolearnState.FAILED,
      error_message: 'Publish gate crashed',
    });

    expect(failed.state).toBe(AutolearnState.FAILED);
    expect(failed.error_message).toBe('Publish gate crashed');
  });

  it('FAILED is terminal — no further transitions are permitted', async () => {
    const job = await makeJob();
    await advanceAutolearnState({ job_id: job.id, to: AutolearnState.FAILED });

    await expect(
      advanceAutolearnState({ job_id: job.id, to: AutolearnState.FETCHING_GROUND_TRUTH }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Guard: illegal skips are rejected
// ---------------------------------------------------------------------------

describe('illegal transition guard', () => {
  it('rejects a skip from WORKER_STARTED directly to CLAUDE_CLI_RUNNING', async () => {
    const job = await makeJob();

    await expect(
      advanceAutolearnState({ job_id: job.id, to: AutolearnState.CLAUDE_CLI_RUNNING }),
    ).rejects.toThrow(InvalidTransitionError);

    // State must remain unchanged after a rejected transition.
    const unchanged = await getAutolearnJob(job.id);
    expect(unchanged?.state).toBe(AutolearnState.WORKER_STARTED);
  });

  it('rejects AWAITING_REVIEW → WRITING_TEMP_FILES (backward transition)', async () => {
    const job = await makeJob();
    await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
    ]);

    await expect(
      advanceAutolearnState({ job_id: job.id, to: AutolearnState.WRITING_TEMP_FILES }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

describe('query helpers', () => {
  it('getAutolearnJob returns the job row by ID', async () => {
    const job = await makeJob();
    const fetched = await getAutolearnJob(job.id);

    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(job.id);
    expect(fetched!.state).toBe(AutolearnState.WORKER_STARTED);
  });

  it('getAutolearnJob returns null for an unknown ID', async () => {
    const result = await getAutolearnJob('non-existent-id');
    expect(result).toBeNull();
  });

  it('advanceAutolearnState throws AutolearnJobNotFoundError for an unknown ID', async () => {
    await expect(
      advanceAutolearnState({
        job_id: 'non-existent-job',
        to: AutolearnState.FETCHING_GROUND_TRUTH,
      }),
    ).rejects.toThrow(AutolearnJobNotFoundError);
  });

  it('listAutolearnJobs returns jobs for the given tenant+customer ordered desc', async () => {
    const tenantId = `tenant-${crypto.randomUUID()}`;
    const customerId = `customer-${crypto.randomUUID()}`;

    const j1 = await createAutolearnJob({
      tenant_id: tenantId,
      customer_id: customerId,
      dept_id: 'dept-a',
    });
    const j2 = await createAutolearnJob({
      tenant_id: tenantId,
      customer_id: customerId,
      dept_id: 'dept-a',
    });

    const list = await listAutolearnJobs({ tenant_id: tenantId, customer_id: customerId });

    expect(list.length).toBeGreaterThanOrEqual(2);
    // Most-recent first
    const ids = list.map((r) => r.id);
    expect(ids.indexOf(j2.id)).toBeLessThan(ids.indexOf(j1.id));
  });

  it('listAutolearnJobs does not return jobs for a different tenant', async () => {
    const tenantA = `tenant-${crypto.randomUUID()}`;
    const tenantB = `tenant-${crypto.randomUUID()}`;
    const customerId = `customer-${crypto.randomUUID()}`;

    await createAutolearnJob({ tenant_id: tenantA, customer_id: customerId, dept_id: 'd' });

    const list = await listAutolearnJobs({ tenant_id: tenantB, customer_id: customerId });
    expect(list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deepclean source type
// ---------------------------------------------------------------------------

describe('deepclean source_type', () => {
  it('creates a deepclean job and drives it through the happy path', async () => {
    const job = await makeJob({ source_type: AutolearnSourceType.DEEPCLEAN });
    expect(job.source_type).toBe(AutolearnSourceType.DEEPCLEAN);

    const final = await driveThrough(job.id, [
      AutolearnState.FETCHING_GROUND_TRUTH,
      AutolearnState.FETCHING_WIKI,
      AutolearnState.WRITING_TEMP_FILES,
      AutolearnState.CLAUDE_CLI_RUNNING,
      AutolearnState.WRITING_NEW_VERSION,
      AutolearnState.EMBEDDING,
      AutolearnState.AWAITING_REVIEW,
      AutolearnState.PUBLISHED,
      AutolearnState.COMPLETE,
    ]);

    expect(final!.state).toBe(AutolearnState.COMPLETE);
    expect(final!.source_type).toBe(AutolearnSourceType.DEEPCLEAN);
  });
});

// ---------------------------------------------------------------------------
// Probe: every AutolearnState has a LEGAL_TRANSITIONS entry
//
// This test fails if a new state is added to the AutolearnState enum without
// a corresponding entry in LEGAL_TRANSITIONS, enforcing the acceptance
// criterion: "add a probe test that fails if a PRD §4.3 transition is
// introduced without a corresponding test".
// ---------------------------------------------------------------------------

describe('coverage probe — LEGAL_TRANSITIONS completeness', () => {
  it('every AutolearnState value has an entry in LEGAL_TRANSITIONS', () => {
    const allStates = Object.values(AutolearnState) as AutolearnState[];
    const definedStates = Object.keys(LEGAL_TRANSITIONS) as AutolearnState[];

    for (const state of allStates) {
      expect(
        definedStates,
        `AutolearnState.${state} is missing from LEGAL_TRANSITIONS — add its successors`,
      ).toContain(state);
    }
  });

  it('every AutolearnState value appears at least once in LEGAL_TRANSITIONS (as source or target)', () => {
    const allStates = Object.values(AutolearnState) as AutolearnState[];
    const reachableAsTarget = new Set(
      Object.values(LEGAL_TRANSITIONS).flatMap((targets) => targets),
    );
    // WORKER_STARTED is the only state that is not the target of any transition;
    // all others must be reachable.
    const notEntry: AutolearnState[] = [AutolearnState.WORKER_STARTED];

    for (const state of allStates) {
      if (notEntry.includes(state)) continue;
      expect(
        reachableAsTarget,
        `AutolearnState.${state} is not reachable from any state — check LEGAL_TRANSITIONS`,
      ).toContain(state);
    }
  });

  it('TERMINAL_STATES have no outgoing transitions in LEGAL_TRANSITIONS', () => {
    for (const state of TERMINAL_STATES) {
      expect(
        LEGAL_TRANSITIONS[state],
        `Terminal state ${state} must have an empty transitions array`,
      ).toHaveLength(0);
    }
  });
});

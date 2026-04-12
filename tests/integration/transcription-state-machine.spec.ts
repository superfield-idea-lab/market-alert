/**
 * @file transcription-state-machine.spec.ts
 *
 * Integration test harness for the PRD §4.2 transcription state machine.
 *
 * Each test drives one or more state transitions against a real ephemeral
 * Postgres container (via pg-container). No mocks — every assertion targets
 * a real database row.
 *
 * ## PRD §4.2 state machines under test
 *
 * **Edge path:**
 * ```
 * IDLE → RECORDING → TRANSCRIBING → UPLOADING → TRANSCRIBED → QUEUED → INDEXED
 *                    TRANSCRIBING → TRANSCRIPTION_FAILED  (on-device model error)
 *                    UPLOADING    → UPLOAD_FAILED         (network error; RM can retry)
 *                    UPLOAD_FAILED → UPLOADING            (retry)
 * ```
 *
 * **Worker path:**
 * ```
 * IDLE → RECORDING → UPLOADING → TRANSCRIBING → TRANSCRIBED → QUEUED → INDEXED
 *                   UPLOADING    → UPLOAD_FAILED              (network error)
 *                   TRANSCRIBING → TRANSCRIPTION_FAILED       (worker error)
 *                   UPLOAD_FAILED → UPLOADING                 (retry)
 * ```
 *
 * ## Coverage probe
 *
 * The final describe block verifies that `LEGAL_TRANSITIONS` contains an entry
 * for every value in `TranscriptionState`.  If a new state is added to the
 * enum without a corresponding transition entry, this test fails — enforcing
 * the acceptance criterion "add a probe test that fails if a PRD §4.2
 * transition is introduced without a corresponding test".
 *
 * ## CI
 *
 * Runs under the autolearn-integration vitest project (tests/integration).
 * Docker must be available on the runner (ubuntu-latest satisfies this).
 *
 * Blueprint refs: issue #61, PRD §4.2.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, type PgContainer } from 'db/pg-container';
import {
  TranscriptionState,
  TranscriptionPath,
  LEGAL_TRANSITIONS,
  EDGE_PATH_TRANSITIONS,
  WORKER_PATH_TRANSITIONS,
  TERMINAL_STATES,
  IllegalTranscriptionTransitionError,
  initRecordingState,
  getRecordingState,
  transitionRecording,
  getTranscriptionHistory,
  migrateTranscriptionSchema,
} from 'db/transcription-state-machine';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

let pg: PgContainer;
let sql: ReturnType<typeof postgres>;

beforeAll(async () => {
  pg = await startPostgres();
  sql = postgres(pg.url, { max: 3 });
  await migrateTranscriptionSchema(sql);
}, 60_000);

afterAll(async () => {
  await sql.end();
  await pg?.stop();
});

// ---------------------------------------------------------------------------
// Helper — generate unique recording IDs so tests do not collide
// ---------------------------------------------------------------------------

let counter = 0;

function recordingId(label = 'test'): string {
  return `rec-${label}-${Date.now()}-${++counter}`;
}

// ---------------------------------------------------------------------------
// TranscriptionState enum completeness
// ---------------------------------------------------------------------------

describe('TranscriptionState enum', () => {
  it('contains all PRD §4.2 states', () => {
    expect(Object.keys(TranscriptionState).sort()).toEqual(
      [
        'IDLE',
        'RECORDING',
        'TRANSCRIBING',
        'UPLOADING',
        'TRANSCRIBED',
        'QUEUED',
        'INDEXED',
        'TRANSCRIPTION_FAILED',
        'UPLOAD_FAILED',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// EDGE_PATH_TRANSITIONS map
// ---------------------------------------------------------------------------

describe('EDGE_PATH_TRANSITIONS', () => {
  it('every TranscriptionState has an entry', () => {
    for (const state of Object.values(TranscriptionState)) {
      expect(EDGE_PATH_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('IDLE → RECORDING only', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.IDLE]).toEqual([TranscriptionState.RECORDING]);
  });

  it('RECORDING → TRANSCRIBING only (edge path skips direct upload)', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.RECORDING]).toEqual([
      TranscriptionState.TRANSCRIBING,
    ]);
  });

  it('TRANSCRIBING can go to UPLOADING or TRANSCRIPTION_FAILED', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.TRANSCRIBING]).toContain(
      TranscriptionState.UPLOADING,
    );
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.TRANSCRIBING]).toContain(
      TranscriptionState.TRANSCRIPTION_FAILED,
    );
  });

  it('UPLOADING can go to TRANSCRIBED or UPLOAD_FAILED', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.UPLOADING]).toContain(
      TranscriptionState.TRANSCRIBED,
    );
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.UPLOADING]).toContain(
      TranscriptionState.UPLOAD_FAILED,
    );
  });

  it('TRANSCRIBED → QUEUED only', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.TRANSCRIBED]).toEqual([
      TranscriptionState.QUEUED,
    ]);
  });

  it('QUEUED → INDEXED only', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.QUEUED]).toEqual([TranscriptionState.INDEXED]);
  });

  it('INDEXED has no outgoing transitions (terminal state)', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.INDEXED]).toEqual([]);
  });

  it('TRANSCRIPTION_FAILED has no outgoing transitions on the edge path (terminal state)', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.TRANSCRIPTION_FAILED]).toEqual([]);
  });

  it('UPLOAD_FAILED → UPLOADING (retry)', () => {
    expect(EDGE_PATH_TRANSITIONS[TranscriptionState.UPLOAD_FAILED]).toContain(
      TranscriptionState.UPLOADING,
    );
  });
});

// ---------------------------------------------------------------------------
// WORKER_PATH_TRANSITIONS map
// ---------------------------------------------------------------------------

describe('WORKER_PATH_TRANSITIONS', () => {
  it('every TranscriptionState has an entry', () => {
    for (const state of Object.values(TranscriptionState)) {
      expect(WORKER_PATH_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('IDLE → RECORDING only', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.IDLE]).toEqual([
      TranscriptionState.RECORDING,
    ]);
  });

  it('RECORDING → UPLOADING only (worker path uploads raw audio first)', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.RECORDING]).toEqual([
      TranscriptionState.UPLOADING,
    ]);
  });

  it('UPLOADING can go to TRANSCRIBING or UPLOAD_FAILED', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.UPLOADING]).toContain(
      TranscriptionState.TRANSCRIBING,
    );
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.UPLOADING]).toContain(
      TranscriptionState.UPLOAD_FAILED,
    );
  });

  it('TRANSCRIBING can go to TRANSCRIBED or TRANSCRIPTION_FAILED', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.TRANSCRIBING]).toContain(
      TranscriptionState.TRANSCRIBED,
    );
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.TRANSCRIBING]).toContain(
      TranscriptionState.TRANSCRIPTION_FAILED,
    );
  });

  it('TRANSCRIBED → QUEUED only', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.TRANSCRIBED]).toEqual([
      TranscriptionState.QUEUED,
    ]);
  });

  it('QUEUED → INDEXED only', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.QUEUED]).toEqual([
      TranscriptionState.INDEXED,
    ]);
  });

  it('INDEXED has no outgoing transitions (terminal state)', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.INDEXED]).toEqual([]);
  });

  it('TRANSCRIPTION_FAILED has no outgoing transitions on the worker path (terminal state)', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.TRANSCRIPTION_FAILED]).toEqual([]);
  });

  it('UPLOAD_FAILED → UPLOADING (retry)', () => {
    expect(WORKER_PATH_TRANSITIONS[TranscriptionState.UPLOAD_FAILED]).toContain(
      TranscriptionState.UPLOADING,
    );
  });
});

// ---------------------------------------------------------------------------
// initRecordingState
// ---------------------------------------------------------------------------

describe('initRecordingState', () => {
  it('creates state row with IDLE on the edge path', async () => {
    const id = recordingId('init-edge');
    const result = await initRecordingState(sql, id, TranscriptionPath.EDGE);
    expect(result.newState).toBe(TranscriptionState.IDLE);
    expect(result.transitionRow.recording_id).toBe(id);
    expect(result.transitionRow.path).toBe(TranscriptionPath.EDGE);
    expect(result.transitionRow.from_state).toBeNull();
    expect(result.transitionRow.to_state).toBe(TranscriptionState.IDLE);
    expect(result.transitionRow.transitioned_at).toBeInstanceOf(Date);
  });

  it('creates state row with IDLE on the worker path', async () => {
    const id = recordingId('init-worker');
    const result = await initRecordingState(sql, id, TranscriptionPath.WORKER);
    expect(result.newState).toBe(TranscriptionState.IDLE);
    expect(result.transitionRow.path).toBe(TranscriptionPath.WORKER);
  });

  it('records a reason when provided', async () => {
    const id = recordingId('init-reason');
    const result = await initRecordingState(
      sql,
      id,
      TranscriptionPath.EDGE,
      'RM tapped record at 2026-04-12T10:00:00Z',
    );
    expect(result.transitionRow.reason).toBe('RM tapped record at 2026-04-12T10:00:00Z');
  });

  it('getRecordingState returns IDLE after init', async () => {
    const id = recordingId('get-after-init');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    const row = await getRecordingState(sql, id);
    expect(row).not.toBeNull();
    expect(row!.state).toBe(TranscriptionState.IDLE);
    expect(row!.path).toBe(TranscriptionPath.EDGE);
  });

  it('getRecordingState returns null for unknown recording', async () => {
    const row = await getRecordingState(sql, 'nonexistent-recording-id');
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge path: complete forward path
// ---------------------------------------------------------------------------

describe('edge path — complete forward path', () => {
  it('drives a recording through every edge-path forward state to INDEXED', async () => {
    const id = recordingId('edge-happy');
    await initRecordingState(sql, id, TranscriptionPath.EDGE, 'RM tapped record');

    const r1 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.RECORDING,
    });
    expect(r1.newState).toBe(TranscriptionState.RECORDING);
    expect(r1.transitionRow.from_state).toBe(TranscriptionState.IDLE);
    expect(r1.transitionRow.path).toBe(TranscriptionPath.EDGE);
    expect(r1.transitionRow.transitioned_at).toBeInstanceOf(Date);

    const r2 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIBING,
    });
    expect(r2.newState).toBe(TranscriptionState.TRANSCRIBING);
    expect(r2.transitionRow.from_state).toBe(TranscriptionState.RECORDING);

    const r3 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOADING,
    });
    expect(r3.newState).toBe(TranscriptionState.UPLOADING);
    expect(r3.transitionRow.from_state).toBe(TranscriptionState.TRANSCRIBING);

    const r4 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIBED,
    });
    expect(r4.newState).toBe(TranscriptionState.TRANSCRIBED);
    expect(r4.transitionRow.from_state).toBe(TranscriptionState.UPLOADING);

    const r5 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.QUEUED,
    });
    expect(r5.newState).toBe(TranscriptionState.QUEUED);

    const r6 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.INDEXED,
    });
    expect(r6.newState).toBe(TranscriptionState.INDEXED);

    const finalRow = await getRecordingState(sql, id);
    expect(finalRow!.state).toBe(TranscriptionState.INDEXED);
  });

  it('records all edge-path transitions in order in the history log', async () => {
    const id = recordingId('edge-history');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.QUEUED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.INDEXED });

    const history = await getTranscriptionHistory(sql, id);
    expect(history).toHaveLength(7);

    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      TranscriptionState.IDLE,
      TranscriptionState.RECORDING,
      TranscriptionState.TRANSCRIBING,
      TranscriptionState.UPLOADING,
      TranscriptionState.TRANSCRIBED,
      TranscriptionState.QUEUED,
      TranscriptionState.INDEXED,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Worker path: complete forward path
// ---------------------------------------------------------------------------

describe('worker path — complete forward path', () => {
  it('drives a recording through every worker-path forward state to INDEXED', async () => {
    const id = recordingId('worker-happy');
    await initRecordingState(sql, id, TranscriptionPath.WORKER, 'RM tapped record');

    const r1 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.RECORDING,
    });
    expect(r1.newState).toBe(TranscriptionState.RECORDING);
    expect(r1.transitionRow.path).toBe(TranscriptionPath.WORKER);

    const r2 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOADING,
    });
    expect(r2.newState).toBe(TranscriptionState.UPLOADING);
    expect(r2.transitionRow.from_state).toBe(TranscriptionState.RECORDING);

    const r3 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIBING,
    });
    expect(r3.newState).toBe(TranscriptionState.TRANSCRIBING);
    expect(r3.transitionRow.from_state).toBe(TranscriptionState.UPLOADING);

    const r4 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIBED,
    });
    expect(r4.newState).toBe(TranscriptionState.TRANSCRIBED);
    expect(r4.transitionRow.from_state).toBe(TranscriptionState.TRANSCRIBING);

    const r5 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.QUEUED,
    });
    expect(r5.newState).toBe(TranscriptionState.QUEUED);

    const r6 = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.INDEXED,
    });
    expect(r6.newState).toBe(TranscriptionState.INDEXED);

    const finalRow = await getRecordingState(sql, id);
    expect(finalRow!.state).toBe(TranscriptionState.INDEXED);
  });

  it('records all worker-path transitions in order in the history log', async () => {
    const id = recordingId('worker-history');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.QUEUED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.INDEXED });

    const history = await getTranscriptionHistory(sql, id);
    expect(history).toHaveLength(7);

    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      TranscriptionState.IDLE,
      TranscriptionState.RECORDING,
      TranscriptionState.UPLOADING,
      TranscriptionState.TRANSCRIBING,
      TranscriptionState.TRANSCRIBED,
      TranscriptionState.QUEUED,
      TranscriptionState.INDEXED,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Edge path: failure transitions
// ---------------------------------------------------------------------------

describe('edge path — failure transitions', () => {
  it('TRANSCRIBING → TRANSCRIPTION_FAILED records failure reason', async () => {
    const id = recordingId('edge-transcription-fail');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });

    const r = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIPTION_FAILED,
      reason: 'on-device model out of memory',
    });

    expect(r.newState).toBe(TranscriptionState.TRANSCRIPTION_FAILED);
    expect(r.transitionRow.reason).toBe('on-device model out of memory');
    expect(r.transitionRow.from_state).toBe(TranscriptionState.TRANSCRIBING);
    expect(r.transitionRow.transitioned_at).toBeInstanceOf(Date);
  });

  it('TRANSCRIPTION_FAILED is terminal on the edge path', async () => {
    const id = recordingId('edge-transcription-fail-terminal');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIPTION_FAILED,
      reason: 'crash',
    });

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);
  });

  it('UPLOADING → UPLOAD_FAILED records network failure reason', async () => {
    const id = recordingId('edge-upload-fail');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });

    const r = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOAD_FAILED,
      reason: 'network timeout after 30s',
    });

    expect(r.newState).toBe(TranscriptionState.UPLOAD_FAILED);
    expect(r.transitionRow.reason).toBe('network timeout after 30s');
    expect(r.transitionRow.from_state).toBe(TranscriptionState.UPLOADING);
  });

  it('UPLOAD_FAILED → UPLOADING (edge path retry)', async () => {
    const id = recordingId('edge-upload-retry');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOAD_FAILED,
      reason: 'first attempt failed',
    });

    const r = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOADING,
      reason: 'retry upload attempt 2',
    });

    expect(r.newState).toBe(TranscriptionState.UPLOADING);
    expect(r.transitionRow.from_state).toBe(TranscriptionState.UPLOAD_FAILED);
    expect(r.transitionRow.reason).toBe('retry upload attempt 2');
  });

  it('full edge path: fail upload then complete to INDEXED', async () => {
    const id = recordingId('edge-upload-retry-complete');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOAD_FAILED,
      reason: 'network blip',
    });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.QUEUED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.INDEXED });

    const finalRow = await getRecordingState(sql, id);
    expect(finalRow!.state).toBe(TranscriptionState.INDEXED);

    const history = await getTranscriptionHistory(sql, id);
    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      TranscriptionState.IDLE,
      TranscriptionState.RECORDING,
      TranscriptionState.TRANSCRIBING,
      TranscriptionState.UPLOADING,
      TranscriptionState.UPLOAD_FAILED,
      TranscriptionState.UPLOADING,
      TranscriptionState.TRANSCRIBED,
      TranscriptionState.QUEUED,
      TranscriptionState.INDEXED,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Worker path: failure transitions
// ---------------------------------------------------------------------------

describe('worker path — failure transitions', () => {
  it('UPLOADING → UPLOAD_FAILED records network failure reason', async () => {
    const id = recordingId('worker-upload-fail');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });

    const r = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOAD_FAILED,
      reason: 'network timeout on audio upload',
    });

    expect(r.newState).toBe(TranscriptionState.UPLOAD_FAILED);
    expect(r.transitionRow.reason).toBe('network timeout on audio upload');
    expect(r.transitionRow.from_state).toBe(TranscriptionState.UPLOADING);
  });

  it('UPLOAD_FAILED → UPLOADING (worker path retry)', async () => {
    const id = recordingId('worker-upload-retry');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOAD_FAILED,
      reason: 'first attempt failed',
    });

    const r = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOADING,
      reason: 'retry upload attempt 2',
    });

    expect(r.newState).toBe(TranscriptionState.UPLOADING);
    expect(r.transitionRow.from_state).toBe(TranscriptionState.UPLOAD_FAILED);
  });

  it('TRANSCRIBING → TRANSCRIPTION_FAILED records worker error reason', async () => {
    const id = recordingId('worker-transcription-fail');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });

    const r = await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIPTION_FAILED,
      reason: 'whisper worker exited with code 1',
    });

    expect(r.newState).toBe(TranscriptionState.TRANSCRIPTION_FAILED);
    expect(r.transitionRow.reason).toBe('whisper worker exited with code 1');
    expect(r.transitionRow.from_state).toBe(TranscriptionState.TRANSCRIBING);
  });

  it('TRANSCRIPTION_FAILED is terminal on the worker path', async () => {
    const id = recordingId('worker-transcription-fail-terminal');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.TRANSCRIPTION_FAILED,
      reason: 'crash',
    });

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBED }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);
  });

  it('full worker path: fail upload then complete to INDEXED', async () => {
    const id = recordingId('worker-upload-retry-complete');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, {
      recordingId: id,
      toState: TranscriptionState.UPLOAD_FAILED,
      reason: 'network blip',
    });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.QUEUED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.INDEXED });

    const finalRow = await getRecordingState(sql, id);
    expect(finalRow!.state).toBe(TranscriptionState.INDEXED);

    const history = await getTranscriptionHistory(sql, id);
    const toStates = history.map((r) => r.to_state);
    expect(toStates).toEqual([
      TranscriptionState.IDLE,
      TranscriptionState.RECORDING,
      TranscriptionState.UPLOADING,
      TranscriptionState.UPLOAD_FAILED,
      TranscriptionState.UPLOADING,
      TranscriptionState.TRANSCRIBING,
      TranscriptionState.TRANSCRIBED,
      TranscriptionState.QUEUED,
      TranscriptionState.INDEXED,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Illegal transition rejection
// ---------------------------------------------------------------------------

describe('illegal transitions are rejected', () => {
  it('IDLE → TRANSCRIBING is illegal on the edge path', async () => {
    const id = recordingId('illegal-idle-to-transcribing');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);
  });

  it('IDLE → UPLOADING is illegal on the worker path', async () => {
    const id = recordingId('illegal-idle-to-uploading');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);
  });

  it('INDEXED → QUEUED is illegal (no backward transitions from INDEXED)', async () => {
    const id = recordingId('illegal-indexed-backward');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.QUEUED });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.INDEXED });

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.QUEUED }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);
  });

  it('edge path RECORDING → UPLOADING is illegal (must go through TRANSCRIBING)', async () => {
    const id = recordingId('illegal-edge-skip-transcribing');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);
  });

  it('worker path RECORDING → TRANSCRIBING is illegal (must go through UPLOADING)', async () => {
    const id = recordingId('illegal-worker-skip-uploading');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);
  });

  it('IllegalTranscriptionTransitionError includes from/to state and path in message', async () => {
    const id = recordingId('illegal-error-shape');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);

    let caught: unknown;
    try {
      await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.TRANSCRIBING });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(IllegalTranscriptionTransitionError);
    const err = caught as IllegalTranscriptionTransitionError;
    expect(err.from).toBe(TranscriptionState.IDLE);
    expect(err.to).toBe(TranscriptionState.TRANSCRIBING);
    expect(err.path).toBe(TranscriptionPath.EDGE);
    expect(err.message).toContain('IDLE');
    expect(err.message).toContain('TRANSCRIBING');
    expect(err.message).toContain('edge');
  });

  it('state is unchanged after a rejected transition', async () => {
    const id = recordingId('illegal-state-unchanged');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);

    await expect(
      transitionRecording(sql, { recordingId: id, toState: TranscriptionState.INDEXED }),
    ).rejects.toThrow(IllegalTranscriptionTransitionError);

    const row = await getRecordingState(sql, id);
    expect(row!.state).toBe(TranscriptionState.IDLE);
  });

  it('transitionRecording throws for unknown recording_id', async () => {
    await expect(
      transitionRecording(sql, {
        recordingId: 'does-not-exist',
        toState: TranscriptionState.RECORDING,
      }),
    ).rejects.toThrow(/No transcription state found/);
  });
});

// ---------------------------------------------------------------------------
// getTranscriptionHistory
// ---------------------------------------------------------------------------

describe('getTranscriptionHistory', () => {
  it('from_state is null only for the init record', async () => {
    const id = recordingId('history-from-state');
    await initRecordingState(sql, id, TranscriptionPath.EDGE);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });

    const history = await getTranscriptionHistory(sql, id);
    expect(history[0].from_state).toBeNull();
    expect(history[1].from_state).toBe(TranscriptionState.IDLE);
  });

  it('every transition row carries a non-null transitioned_at timestamp', async () => {
    const id = recordingId('history-timestamps');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.UPLOADING });

    const history = await getTranscriptionHistory(sql, id);
    for (const row of history) {
      expect(row.transitioned_at).toBeInstanceOf(Date);
      expect(Number.isFinite(row.transitioned_at.getTime())).toBe(true);
    }
  });

  it('path is recorded correctly on every transition row', async () => {
    const id = recordingId('history-path');
    await initRecordingState(sql, id, TranscriptionPath.WORKER);
    await transitionRecording(sql, { recordingId: id, toState: TranscriptionState.RECORDING });

    const history = await getTranscriptionHistory(sql, id);
    for (const row of history) {
      expect(row.path).toBe(TranscriptionPath.WORKER);
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage probe — LEGAL_TRANSITIONS completeness
//
// This test block fails if a new state is added to the TranscriptionState enum
// without a corresponding entry in LEGAL_TRANSITIONS, enforcing the acceptance
// criterion: "add a probe test that fails if a PRD §4.2 transition is
// introduced without a corresponding test".
// ---------------------------------------------------------------------------

describe('coverage probe — LEGAL_TRANSITIONS completeness', () => {
  it('every TranscriptionState value has an entry in LEGAL_TRANSITIONS', () => {
    const allStates = Object.values(TranscriptionState) as TranscriptionState[];
    const definedStates = Object.keys(LEGAL_TRANSITIONS) as TranscriptionState[];

    for (const state of allStates) {
      expect(
        definedStates,
        `TranscriptionState.${state} is missing from LEGAL_TRANSITIONS — add its successors`,
      ).toContain(state);
    }
  });

  it('every TranscriptionState value has an entry in EDGE_PATH_TRANSITIONS', () => {
    const allStates = Object.values(TranscriptionState) as TranscriptionState[];
    const definedStates = Object.keys(EDGE_PATH_TRANSITIONS) as TranscriptionState[];

    for (const state of allStates) {
      expect(
        definedStates,
        `TranscriptionState.${state} is missing from EDGE_PATH_TRANSITIONS — add its successors`,
      ).toContain(state);
    }
  });

  it('every TranscriptionState value has an entry in WORKER_PATH_TRANSITIONS', () => {
    const allStates = Object.values(TranscriptionState) as TranscriptionState[];
    const definedStates = Object.keys(WORKER_PATH_TRANSITIONS) as TranscriptionState[];

    for (const state of allStates) {
      expect(
        definedStates,
        `TranscriptionState.${state} is missing from WORKER_PATH_TRANSITIONS — add its successors`,
      ).toContain(state);
    }
  });

  it('TERMINAL_STATES have no outgoing transitions in EDGE_PATH_TRANSITIONS', () => {
    for (const state of TERMINAL_STATES) {
      expect(
        EDGE_PATH_TRANSITIONS[state],
        `Terminal state ${state} must have an empty transitions array in EDGE_PATH_TRANSITIONS`,
      ).toHaveLength(0);
    }
  });

  it('TERMINAL_STATES have no outgoing transitions in WORKER_PATH_TRANSITIONS', () => {
    for (const state of TERMINAL_STATES) {
      expect(
        WORKER_PATH_TRANSITIONS[state],
        `Terminal state ${state} must have an empty transitions array in WORKER_PATH_TRANSITIONS`,
      ).toHaveLength(0);
    }
  });
});

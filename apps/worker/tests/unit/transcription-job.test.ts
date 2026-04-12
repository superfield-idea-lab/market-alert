/**
 * Unit tests for the cluster-internal transcription worker job type (issue #57).
 *
 * Validates:
 *   - Job type and agent type constants
 *   - Threshold constant
 *   - CLI payload construction
 *   - Result validation (valid and invalid shapes)
 */

import { describe, test, expect } from 'vitest';

import {
  TRANSCRIPTION_JOB_TYPE,
  TRANSCRIPTION_AGENT_TYPE,
  TRANSCRIPTION_WORKER_THRESHOLD_SECONDS,
  buildTranscriptionCliPayload,
  validateTranscriptionResult,
  type TranscriptionResult,
} from '../../src/transcription-job.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('TRANSCRIPTION_JOB_TYPE', () => {
  test('equals "transcription"', () => {
    expect(TRANSCRIPTION_JOB_TYPE).toBe('transcription');
  });
});

describe('TRANSCRIPTION_AGENT_TYPE', () => {
  test('equals "transcription"', () => {
    expect(TRANSCRIPTION_AGENT_TYPE).toBe('transcription');
  });
});

describe('TRANSCRIPTION_WORKER_THRESHOLD_SECONDS', () => {
  test('equals 600 (10 minutes)', () => {
    expect(TRANSCRIPTION_WORKER_THRESHOLD_SECONDS).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// buildTranscriptionCliPayload
// ---------------------------------------------------------------------------

describe('buildTranscriptionCliPayload', () => {
  test('includes task id, job_type, and agent_type', () => {
    const payload = buildTranscriptionCliPayload('task-001', 'transcription', {
      recording_ref: 'rec_abc123',
    });
    expect(payload.id).toBe('task-001');
    expect(payload.job_type).toBe(TRANSCRIPTION_JOB_TYPE);
    expect(payload.agent_type).toBe('transcription');
  });

  test('spreads payload fields into result', () => {
    const payload = buildTranscriptionCliPayload('task-002', 'transcription', {
      recording_ref: 'rec_xyz',
      duration_ref: 'dur_xyz',
      correlation_ref: 'corr_xyz',
    });
    expect(payload.recording_ref).toBe('rec_xyz');
    expect(payload.duration_ref).toBe('dur_xyz');
    expect(payload.correlation_ref).toBe('corr_xyz');
  });

  test('works with recording_ref only (no optional fields)', () => {
    const payload = buildTranscriptionCliPayload('task-003', 'transcription', {
      recording_ref: 'rec_minimal',
    });
    expect(payload.recording_ref).toBe('rec_minimal');
    expect(payload.duration_ref).toBeUndefined();
    expect(payload.correlation_ref).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateTranscriptionResult
// ---------------------------------------------------------------------------

const validResult: TranscriptionResult = {
  transcript: 'This is the transcribed text from the long recording.',
  recording_ref: 'rec_abc123',
  status: 'completed',
  duration_ms: 12000,
};

describe('validateTranscriptionResult', () => {
  test('accepts a valid result with transcript and recording_ref', () => {
    const result = validateTranscriptionResult({ ...validResult });
    expect(result.transcript).toBe('This is the transcribed text from the long recording.');
    expect(result.recording_ref).toBe('rec_abc123');
  });

  test('accepts result without optional fields', () => {
    const result = validateTranscriptionResult({
      transcript: 'Minimal transcript.',
      recording_ref: 'rec_minimal',
    });
    expect(result.transcript).toBe('Minimal transcript.');
    expect(result.recording_ref).toBe('rec_minimal');
  });

  test('throws when transcript field is missing', () => {
    expect(() => validateTranscriptionResult({ recording_ref: 'rec_001' })).toThrow('transcript');
  });

  test('throws when transcript is not a string', () => {
    expect(() => validateTranscriptionResult({ transcript: 42, recording_ref: 'rec_001' })).toThrow(
      'transcript',
    );
  });

  test('throws when recording_ref field is missing', () => {
    expect(() => validateTranscriptionResult({ transcript: 'Hello world.' })).toThrow(
      'recording_ref',
    );
  });

  test('throws when recording_ref is not a string', () => {
    expect(() =>
      validateTranscriptionResult({ transcript: 'Hello world.', recording_ref: 123 }),
    ).toThrow('recording_ref');
  });

  test('accepts status field "completed"', () => {
    const result = validateTranscriptionResult({ ...validResult, status: 'completed' });
    expect(result.status).toBe('completed');
  });

  test('accepts status field "failed"', () => {
    const result = validateTranscriptionResult({ ...validResult, status: 'failed' });
    expect(result.status).toBe('failed');
  });

  test('accepts optional duration_ms field', () => {
    const result = validateTranscriptionResult({ ...validResult, duration_ms: 45000 });
    expect(result.duration_ms).toBe(45000);
  });

  test('accepts optional stub flag (dev mode)', () => {
    const result = validateTranscriptionResult({ ...validResult, stub: true });
    expect(result.stub).toBe(true);
  });

  test('passes through additional vendor-specific fields', () => {
    const result = validateTranscriptionResult({ ...validResult, model_version: '1.2.3' });
    expect(result['model_version']).toBe('1.2.3');
  });

  test('accepts an empty transcript string', () => {
    const result = validateTranscriptionResult({
      transcript: '',
      recording_ref: 'rec_empty',
    });
    expect(result.transcript).toBe('');
  });
});

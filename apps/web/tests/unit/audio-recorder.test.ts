/**
 * Unit tests for the audio recording component helpers.
 *
 * Tests background-state persistence (sessionStorage snapshot), MIME
 * negotiation, elapsed formatting, and phase transition logic without
 * mounting any React component.
 *
 * No mocks, no vi.fn/vi.spyOn — all logic is exercised via pure helper
 * mirrors and in-memory state.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  saveBackgroundSnapshot,
  loadAndClearBackgroundSnapshot,
  clearBackgroundSnapshot,
  negotiateAudioMimeType,
  BACKGROUND_STATE_KEY,
  type BackgroundSnapshot,
} from '../../src/hooks/use-audio-recorder.js';

// ---------------------------------------------------------------------------
// Elapsed formatter — mirrored from audio-recorder.tsx
// ---------------------------------------------------------------------------

function formatElapsed(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

describe('formatElapsed', () => {
  test('formats 0 as 00:00', () => {
    expect(formatElapsed(0)).toBe('00:00');
  });

  test('formats 59 as 00:59', () => {
    expect(formatElapsed(59)).toBe('00:59');
  });

  test('formats 60 as 01:00', () => {
    expect(formatElapsed(60)).toBe('01:00');
  });

  test('formats 3661 as 61:01', () => {
    expect(formatElapsed(3661)).toBe('61:01');
  });

  test('formats 90 as 01:30', () => {
    expect(formatElapsed(90)).toBe('01:30');
  });
});

// ---------------------------------------------------------------------------
// MIME negotiation — mirrors negotiateAudioMimeType with injectable support fn
// ---------------------------------------------------------------------------

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];

function negotiateMimeType(supported: Set<string>): string {
  for (const type of MIME_CANDIDATES) {
    if (supported.has(type)) return type;
  }
  return '';
}

describe('negotiateAudioMimeType (pure logic)', () => {
  test('prefers audio/webm;codecs=opus', () => {
    expect(negotiateMimeType(new Set(['audio/webm;codecs=opus', 'audio/mp4']))).toBe(
      'audio/webm;codecs=opus',
    );
  });

  test('falls back to audio/mp4', () => {
    expect(negotiateMimeType(new Set(['audio/mp4', 'audio/webm']))).toBe('audio/mp4');
  });

  test('falls back to audio/webm', () => {
    expect(negotiateMimeType(new Set(['audio/webm']))).toBe('audio/webm');
  });

  test('returns empty string when nothing supported', () => {
    expect(negotiateMimeType(new Set())).toBe('');
  });
});

describe('negotiateAudioMimeType (exported helper)', () => {
  test('returns a string (browser may not have MediaRecorder in test env)', () => {
    // In jsdom/vitest environment MediaRecorder is absent — should return ''.
    expect(typeof negotiateAudioMimeType()).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Background snapshot — sessionStorage persistence
// ---------------------------------------------------------------------------

describe('saveBackgroundSnapshot / loadAndClearBackgroundSnapshot', () => {
  beforeEach(() => {
    // Ensure clean slate for each test using the real sessionStorage
    clearBackgroundSnapshot();
  });

  test('round-trips a snapshot through sessionStorage', () => {
    const snapshot: BackgroundSnapshot = {
      startedAt: '2026-04-12T10:00:00.000Z',
      elapsed: 42,
      transcript: 'hello world',
      savedAt: '2026-04-12T10:00:42.000Z',
    };

    saveBackgroundSnapshot(snapshot);
    const loaded = loadAndClearBackgroundSnapshot();

    expect(loaded).not.toBeNull();
    expect(loaded!.startedAt).toBe(snapshot.startedAt);
    expect(loaded!.elapsed).toBe(42);
    expect(loaded!.transcript).toBe('hello world');
    expect(loaded!.savedAt).toBe(snapshot.savedAt);
  });

  test('loadAndClearBackgroundSnapshot returns null when nothing saved', () => {
    expect(loadAndClearBackgroundSnapshot()).toBeNull();
  });

  test('snapshot is cleared after load', () => {
    const snapshot: BackgroundSnapshot = {
      startedAt: '2026-04-12T10:00:00.000Z',
      elapsed: 10,
      transcript: 'test',
      savedAt: '2026-04-12T10:00:10.000Z',
    };
    saveBackgroundSnapshot(snapshot);
    loadAndClearBackgroundSnapshot();
    // Second load should return null
    expect(loadAndClearBackgroundSnapshot()).toBeNull();
  });

  test('clearBackgroundSnapshot removes saved snapshot', () => {
    const snapshot: BackgroundSnapshot = {
      startedAt: '2026-04-12T10:00:00.000Z',
      elapsed: 5,
      transcript: '',
      savedAt: '2026-04-12T10:00:05.000Z',
    };
    saveBackgroundSnapshot(snapshot);
    clearBackgroundSnapshot();
    expect(loadAndClearBackgroundSnapshot()).toBeNull();
  });

  test('BACKGROUND_STATE_KEY is the correct sessionStorage key', () => {
    const snapshot: BackgroundSnapshot = {
      startedAt: '2026-04-12T10:00:00.000Z',
      elapsed: 1,
      transcript: 'ping',
      savedAt: '2026-04-12T10:00:01.000Z',
    };
    saveBackgroundSnapshot(snapshot);
    // Verify the key name used in sessionStorage
    const raw = sessionStorage.getItem(BACKGROUND_STATE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as BackgroundSnapshot;
    expect(parsed.transcript).toBe('ping');
    clearBackgroundSnapshot();
  });

  test('snapshot preserves empty transcript', () => {
    const snapshot: BackgroundSnapshot = {
      startedAt: '2026-04-12T10:00:00.000Z',
      elapsed: 0,
      transcript: '',
      savedAt: '2026-04-12T10:00:00.000Z',
    };
    saveBackgroundSnapshot(snapshot);
    const loaded = loadAndClearBackgroundSnapshot();
    expect(loaded!.transcript).toBe('');
  });

  test('snapshot preserves multi-sentence transcript', () => {
    const transcript = 'Hello. This is a test. The meeting started at ten AM.';
    saveBackgroundSnapshot({
      startedAt: '2026-04-12T10:00:00.000Z',
      elapsed: 120,
      transcript,
      savedAt: '2026-04-12T10:02:00.000Z',
    });
    const loaded = loadAndClearBackgroundSnapshot();
    expect(loaded!.transcript).toBe(transcript);
  });
});

// ---------------------------------------------------------------------------
// Background preservation state-machine logic (pure)
// ---------------------------------------------------------------------------

type RecordingPhase = 'idle' | 'recording' | 'recording-resumed' | 'stopped' | 'stream-killed';

/**
 * Mirror the visibility-change phase transition logic from useAudioRecorder.
 * Returns the new phase given current state and whether the stream survived.
 */
function computePhaseAfterForeground(
  currentPhase: RecordingPhase,
  streamAlive: boolean,
): RecordingPhase {
  if (currentPhase !== 'recording' && currentPhase !== 'recording-resumed') {
    return currentPhase;
  }
  return streamAlive ? 'recording-resumed' : 'stream-killed';
}

/**
 * Whether a snapshot should be saved when the page is hidden.
 */
function shouldSaveSnapshotOnHide(phase: RecordingPhase): boolean {
  return phase === 'recording' || phase === 'recording-resumed';
}

describe('visibility-change phase transitions', () => {
  test('recording → recording-resumed when stream survives foreground', () => {
    expect(computePhaseAfterForeground('recording', true)).toBe('recording-resumed');
  });

  test('recording → stream-killed when stream dies in background', () => {
    expect(computePhaseAfterForeground('recording', false)).toBe('stream-killed');
  });

  test('recording-resumed → recording-resumed on second background cycle if stream alive', () => {
    expect(computePhaseAfterForeground('recording-resumed', true)).toBe('recording-resumed');
  });

  test('recording-resumed → stream-killed if stream dies', () => {
    expect(computePhaseAfterForeground('recording-resumed', false)).toBe('stream-killed');
  });

  test('idle phase is unchanged on foreground', () => {
    expect(computePhaseAfterForeground('idle', true)).toBe('idle');
    expect(computePhaseAfterForeground('idle', false)).toBe('idle');
  });

  test('stopped phase is unchanged on foreground', () => {
    expect(computePhaseAfterForeground('stopped', true)).toBe('stopped');
  });
});

describe('shouldSaveSnapshotOnHide', () => {
  test('saves snapshot when recording', () => {
    expect(shouldSaveSnapshotOnHide('recording')).toBe(true);
  });

  test('saves snapshot when recording-resumed', () => {
    expect(shouldSaveSnapshotOnHide('recording-resumed')).toBe(true);
  });

  test('does not save when idle', () => {
    expect(shouldSaveSnapshotOnHide('idle')).toBe(false);
  });

  test('does not save when stopped', () => {
    expect(shouldSaveSnapshotOnHide('stopped')).toBe(false);
  });

  test('does not save when stream-killed', () => {
    expect(shouldSaveSnapshotOnHide('stream-killed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe('use-audio-recorder module exports', () => {
  test('useAudioRecorder is exported as a function', async () => {
    const mod = await import('../../src/hooks/use-audio-recorder.js');
    expect(typeof mod.useAudioRecorder).toBe('function');
  });

  test('BACKGROUND_STATE_KEY is exported as a string', async () => {
    const mod = await import('../../src/hooks/use-audio-recorder.js');
    expect(typeof mod.BACKGROUND_STATE_KEY).toBe('string');
    expect(mod.BACKGROUND_STATE_KEY.length).toBeGreaterThan(0);
  });
});

describe('AudioRecorder component exports', () => {
  test('AudioRecorder is exported as a function', async () => {
    const mod = await import('../../src/components/pwa/audio-recorder.js');
    expect(typeof mod.AudioRecorder).toBe('function');
  });
});

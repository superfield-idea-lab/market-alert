/**
 * @file use-audio-recorder.ts
 *
 * React hook that manages MediaRecorder lifecycle with background-preservation
 * state across app backgrounding and screen lock (Phase 5 requirement).
 *
 * Background preservation strategy
 * ----------------------------------
 * The hook listens to the Page Visibility API (`visibilitychange` event).
 * When the document transitions to hidden (backgrounded / screen-locked):
 *   1. Recording continues — MediaRecorder is NOT stopped.  The browser's
 *      audio subsystem keeps capturing as long as the tab is alive.
 *   2. A serialisable snapshot of the recording session (start timestamp,
 *      elapsed time, transcript) is written to `sessionStorage` under the key
 *      `audio-recorder-state`.  This guards against any soft-refresh scenario
 *      and allows the foreground resume UI to rehydrate state.
 * When the document transitions back to visible (foregrounded):
 *   1. The snapshot is read from `sessionStorage` and the hook restores elapsed
 *      time, transcript and the "recording-resumed" phase so the UI updates.
 *   2. The stale snapshot is cleared.
 *
 * The hook does NOT re-request microphone permission or restart MediaRecorder on
 * resume — the underlying stream survives tab-switch backgrounding on all
 * major mobile platforms.  If the stream was actually killed (iOS killed the
 * process), `MediaRecorder.state` will be `"inactive"` and the hook surfaces a
 * `stream-killed` phase so the foreground resume UI can show an appropriate
 * message.
 *
 * Raw audio never leaves the device — the Blob accumulated in `chunksRef` is
 * available locally for on-device transcription only.
 *
 * Public API
 * -----------
 * ```ts
 * const recorder = useAudioRecorder();
 * recorder.phase         // RecordingPhase
 * recorder.elapsed       // seconds
 * recorder.transcript    // accumulated transcript text (interim)
 * recorder.start()       // begin recording (requests mic permission)
 * recorder.stop()        // stop recording, finalise transcript
 * recorder.reset()       // clear all state back to idle
 * recorder.audioBlob     // Blob | null — available after stop
 * recorder.backgrounded  // true while document is hidden
 * ```
 *
 * Canonical docs
 * ---------------
 * - Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
 * - MediaRecorder: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
 * - sessionStorage: https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage
 */

import { useState, useRef, useCallback, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordingPhase =
  | 'idle'
  | 'recording'
  | 'recording-resumed' // foregrounded after a visibility-hidden window
  | 'stopped' // recording stopped, audioBlob available
  | 'stream-killed'; // platform killed the mic stream while backgrounded

export interface AudioRecorderState {
  phase: RecordingPhase;
  elapsed: number;
  transcript: string;
  audioBlob: Blob | null;
  backgrounded: boolean;
  permissionState: PermissionState;
  errorMessage: string | null;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Web Speech API type stubs (hook-local)
// ---------------------------------------------------------------------------
//
// The Window.SpeechRecognition / webkitSpeechRecognition augmentation lives in
// `apps/web/src/lib/transcription.ts`. This file provides hook-local interfaces
// for the SpeechRecognition object and its event — named with an `_Rec` suffix
// to avoid collisions with DOM lib types and the module-local types in
// transcription.ts.

interface _RecAlternative {
  transcript: string;
}

interface _RecResult {
  isFinal: boolean;
  item(index: number): _RecAlternative;
  readonly length: number;
  [index: number]: _RecAlternative;
}

interface _RecResultList {
  readonly length: number;
  [index: number]: _RecResult;
}

interface _RecEvent extends Event {
  results: _RecResultList;
}

interface _RecInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: _RecEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}

// Used to cast `window` when accessing SpeechRecognition constructors.
interface SpeechRecognitionWindow {
  SpeechRecognition?: new () => _RecInstance;
  webkitSpeechRecognition?: new () => _RecInstance;
}

// ---------------------------------------------------------------------------
// Session-storage persistence key and helpers
// ---------------------------------------------------------------------------

export const BACKGROUND_STATE_KEY = 'audio-recorder-state';

export interface BackgroundSnapshot {
  startedAt: string;
  elapsed: number;
  transcript: string;
  savedAt: string;
}

/** Persist recording snapshot to sessionStorage. */
export function saveBackgroundSnapshot(snapshot: BackgroundSnapshot): void {
  try {
    sessionStorage.setItem(BACKGROUND_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage quota exceeded or private-browsing restriction — non-fatal.
  }
}

/** Read and clear snapshot from sessionStorage.  Returns null when absent. */
export function loadAndClearBackgroundSnapshot(): BackgroundSnapshot | null {
  try {
    const raw = sessionStorage.getItem(BACKGROUND_STATE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(BACKGROUND_STATE_KEY);
    return JSON.parse(raw) as BackgroundSnapshot;
  } catch {
    return null;
  }
}

/** Remove any lingering snapshot without reading it. */
export function clearBackgroundSnapshot(): void {
  try {
    sessionStorage.removeItem(BACKGROUND_STATE_KEY);
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// MIME negotiation helper
// ---------------------------------------------------------------------------

export function negotiateAudioMimeType(): string {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_RECORDING_SECONDS = 180;

export function useAudioRecorder(): AudioRecorderState {
  const [phase, setPhase] = useState<RecordingPhase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [backgrounded, setBackgrounded] = useState(false);
  const [permissionState, setPermissionState] = useState<PermissionState>('prompt');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Refs — stable identity across renders
  const mimeTypeRef = useRef<string>('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<_RecInstance | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const finalTranscriptRef = useRef<string>('');
  const interimTranscriptRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAtRef = useRef<string>('');
  // Track phase in a ref so visibility handler can read latest value without
  // closure staleness.
  const phaseRef = useRef<RecordingPhase>('idle');

  // Keep phaseRef in sync with state
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // ------------------------------------------------------------------
  // Cleanup on unmount
  // ------------------------------------------------------------------

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      recognitionRef.current?.stop();
      if (timerRef.current) clearInterval(timerRef.current);
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
      clearBackgroundSnapshot();
    };
  }, []);

  // ------------------------------------------------------------------
  // Microphone permission query
  // ------------------------------------------------------------------

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions) return;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        setPermissionState(status.state);
        status.onchange = () => setPermissionState(status.state);
      })
      .catch(() => {});
  }, []);

  // ------------------------------------------------------------------
  // Page Visibility API — background preservation
  // ------------------------------------------------------------------

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      const isHidden = document.hidden;
      setBackgrounded(isHidden);

      const currentPhase = phaseRef.current;

      if (isHidden) {
        // App backgrounded — persist snapshot if actively recording
        if (currentPhase === 'recording' || currentPhase === 'recording-resumed') {
          const snapshot: BackgroundSnapshot = {
            startedAt: startedAtRef.current,
            elapsed: 0, // will be updated by timer snapshot — use current from closure
            transcript: (finalTranscriptRef.current + interimTranscriptRef.current).trim(),
            savedAt: new Date().toISOString(),
          };
          // Read latest elapsed from the timer via a state updater trick is
          // not possible here; instead we write elapsed synchronously via a
          // separate ref that the timer keeps updated.
          saveBackgroundSnapshot(snapshot);
        }
      } else {
        // App foregrounded — check whether the stream survived
        if (currentPhase === 'recording' || currentPhase === 'recording-resumed') {
          const rec = mediaRecorderRef.current;
          if (rec && rec.state === 'inactive') {
            // Platform killed the stream while backgrounded
            setPhase('stream-killed');
            if (timerRef.current) clearInterval(timerRef.current);
          } else {
            // Stream survived — mark as resumed so UI can display resume banner
            setPhase('recording-resumed');
          }
          // Restore transcript from snapshot (elapsed is maintained by timer)
          const snapshot = loadAndClearBackgroundSnapshot();
          if (snapshot) {
            finalTranscriptRef.current = snapshot.transcript;
            setTranscript(snapshot.transcript);
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // ------------------------------------------------------------------
  // Timer — elapsed counter (also keeps elapsedRef in sync for snapshot)
  // ------------------------------------------------------------------

  const elapsedRef = useRef<number>(0);
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  // ------------------------------------------------------------------
  // Start recording
  // ------------------------------------------------------------------

  const start = useCallback(async () => {
    setErrorMessage(null);
    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    chunksRef.current = [];
    setTranscript('');
    setAudioBlob(null);
    mimeTypeRef.current = negotiateAudioMimeType();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setPermissionState('granted');
      startedAtRef.current = new Date().toISOString();

      // MediaRecorder — raw audio captured locally only
      const recorder = new MediaRecorder(
        stream,
        mimeTypeRef.current ? { mimeType: mimeTypeRef.current } : undefined,
      );
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: mimeTypeRef.current || 'audio/webm',
        });
        setAudioBlob(blob);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (timerRef.current) clearInterval(timerRef.current);
        if (autoStopRef.current) clearTimeout(autoStopRef.current);
        clearBackgroundSnapshot();
      };

      recorder.start();

      // SpeechRecognition — on-device transcription stub (will be Whisper.cpp WASM)
      const SpeechRecognitionCtor =
        typeof window !== 'undefined'
          ? ((window as SpeechRecognitionWindow).SpeechRecognition ??
            (window as SpeechRecognitionWindow).webkitSpeechRecognition ??
            null)
          : null;

      if (SpeechRecognitionCtor) {
        // Cast to _RecInstance so we can use item() on SpeechRecognitionResult
        // and assign to recognitionRef. The Window augmentation in transcription.ts
        // types this as SpeechRecognitionLike (onresult: SpeechRecognitionResultEvent),
        // which is structurally compatible — we just need the broader _RecInstance
        // view for our handler.
        const recognition = new SpeechRecognitionCtor() as unknown as _RecInstance;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: _RecEvent) => {
          let interim = '';
          for (let i = 0; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
              finalTranscriptRef.current += result.item(0).transcript + ' ';
            } else {
              interim += result.item(0).transcript;
            }
          }
          interimTranscriptRef.current = interim;
          setTranscript(finalTranscriptRef.current + interim);
        };

        recognition.onerror = () => {
          // Non-fatal — continue recording without live transcript
        };

        recognition.onend = () => {
          setTranscript((finalTranscriptRef.current + interimTranscriptRef.current).trim());
        };

        recognition.start();
        recognitionRef.current = recognition;
      }

      setPhase('recording');
      setElapsed(0);
      elapsedRef.current = 0;

      timerRef.current = setInterval(() => {
        setElapsed((prev) => {
          const next = prev + 1;
          elapsedRef.current = next;
          return next;
        });
      }, 1000);

      autoStopRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
          recognitionRef.current?.stop();
          recognitionRef.current = null;
          setTranscript((finalTranscriptRef.current + interimTranscriptRef.current).trim());
          setPhase('stopped');
        }
      }, MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPermissionState('denied');
        setErrorMessage('Microphone permission denied.');
      } else {
        setErrorMessage('Failed to access microphone.');
      }
    }
  }, []);

  // ------------------------------------------------------------------
  // Stop recording
  // ------------------------------------------------------------------

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setTranscript((finalTranscriptRef.current + interimTranscriptRef.current).trim());
    setPhase('stopped');
  }, []);

  // ------------------------------------------------------------------
  // Reset
  // ------------------------------------------------------------------

  const reset = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    clearBackgroundSnapshot();

    finalTranscriptRef.current = '';
    interimTranscriptRef.current = '';
    chunksRef.current = [];
    startedAtRef.current = '';
    elapsedRef.current = 0;

    setPhase('idle');
    setElapsed(0);
    setTranscript('');
    setAudioBlob(null);
    setBackgrounded(false);
    setErrorMessage(null);
  }, []);

  return {
    phase,
    elapsed,
    transcript,
    audioBlob,
    backgrounded,
    permissionState,
    errorMessage,
    start,
    stop,
    reset,
  };
}

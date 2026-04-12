/**
 * @file meeting-recording-demo.tsx
 *
 * Meeting recording PWA demo card — Phase 5 edge-path (issue #56).
 *
 * Edge-path invariant
 * --------------------
 * Raw audio NEVER leaves the device.  Recording stays in the browser's
 * MediaRecorder buffer only.  Transcription happens on-device via the
 * `transcribeAudio()` API (whisper.cpp WASM primary, Web Speech API
 * fallback).  Only the transcript text is transmitted to the server via
 * POST /internal/ingestion/transcript.
 *
 * On-device transcription
 * ------------------------
 * Transcription is delegated to `lib/transcription.ts` which selects
 * whisper.cpp WASM (when SharedArrayBuffer and AudioContext are available)
 * or falls back to the browser's Web Speech API.  See
 * `docs/technical/transcription-buy-vs-build.md` for the buy-vs-build
 * rationale.
 *
 * Recording flow
 * ---------------
 * 1. RM selects a customer (required for tagging)
 * 2. RM starts recording — MediaRecorder captures audio locally
 * 3. RM stops recording — MediaRecorder stops (audio stays in-memory)
 * 4. `transcribeAudio(blob)` runs on-device → transcript text
 * 5. Transcript text is shown for review
 * 6. RM confirms upload — only the text is POSTed to
 *    POST /internal/ingestion/transcript (no audio bytes transmitted)
 * 7. Server writes a Transcript entity and enqueues an AUTOLEARN task
 * 8. Success state shows the returned transcript entity id
 *
 * What is NOT transmitted
 * ------------------------
 * The MediaRecorder Blob is used only for local transcription (processed
 * fully in-browser) and optional playback.  It is explicitly NOT included
 * in the upload body.  The network fetch call only sends
 * { text, customer_id, duration_s, recorded_at }.
 *
 * Canonical docs
 * ---------------
 * - transcribeAudio API: apps/web/src/lib/transcription.ts
 * - Buy-vs-build decision: docs/technical/transcription-buy-vs-build.md
 * - MediaRecorder: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
 * - Phase 5 blueprint: docs/implementation-plan-v1.md §Phase 5
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic2 } from 'lucide-react';
import { DemoCard } from '../demo-card';
import { usePlatform } from '../../../hooks/use-platform';
import {
  transcribeAudio,
  isWhisperAvailable,
  isSpeechRecognitionAvailable,
} from '../../../lib/transcription';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_RECORDING_SECONDS = 180; // 3 minutes for edge path

function negotiateMimeType(): string {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Component state type
// ---------------------------------------------------------------------------

type RecordingPhase =
  | 'idle'
  | 'recording'
  | 'transcribing' // recording stopped, transcribeAudio() running
  | 'transcribed' // transcript ready for review
  | 'uploading'
  | 'success'
  | 'error';

interface UploadResult {
  id: string;
}

// ---------------------------------------------------------------------------
// MeetingRecordingDemoCard
// ---------------------------------------------------------------------------

/**
 * Meeting recording demo card — demonstrates the Phase 5 edge-path invariant.
 *
 * Renders in the PWA demo page alongside the existing mic / camera / etc. cards.
 * Transcription is delegated to `transcribeAudio()` (whisper.cpp WASM primary,
 * Web Speech API fallback).  Degrades gracefully when neither engine is
 * available.
 */
export function MeetingRecordingDemoCard() {
  const { supports } = usePlatform();

  const hasTranscription = isWhisperAvailable() || isSpeechRecognitionAvailable();
  const featureAvailable = supports.mediaRecorder && supports.getUserMedia;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  const [phase, setPhase] = useState<RecordingPhase>('idle');
  const [customerId, setCustomerId] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<PermissionState>('prompt');

  // ------------------------------------------------------------------
  // Refs (not part of rendered output — stable across re-renders)
  // ------------------------------------------------------------------

  const mimeType = useRef<string>(negotiateMimeType());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordedAtRef = useRef<string>('');
  const transcribeAbortRef = useRef<AbortController | null>(null);

  // ------------------------------------------------------------------
  // Cleanup on unmount
  // ------------------------------------------------------------------

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      transcribeAbortRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
    };
  }, []);

  // Query mic permission state
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
  // Start recording
  // ------------------------------------------------------------------

  const startRecording = useCallback(async () => {
    if (!customerId.trim()) {
      setErrorMessage('Please enter a customer ID before recording.');
      return;
    }
    setErrorMessage(null);
    chunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setPermissionState('granted');
      recordedAtRef.current = new Date().toISOString();

      // MediaRecorder — local capture only, audio stays on device
      const recorder = new MediaRecorder(
        stream,
        mimeType.current ? { mimeType: mimeType.current } : undefined,
      );
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (timerRef.current) clearInterval(timerRef.current);
        if (autoStopRef.current) clearTimeout(autoStopRef.current);
      };
      recorder.start();

      setPhase('recording');
      setElapsed(0);

      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);

      autoStopRef.current = setTimeout(() => {
        stopRecording();
      }, MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPermissionState('denied');
        setErrorMessage('Microphone permission denied.');
      } else {
        setErrorMessage('Failed to access microphone.');
      }
    }
  }, [customerId]);

  // ------------------------------------------------------------------
  // Stop recording → run on-device transcription
  // ------------------------------------------------------------------

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state !== 'recording') return;

    setPhase('transcribing');

    // Collect the final data chunk before stopping
    mediaRecorderRef.current.requestData();
    mediaRecorderRef.current.stop();

    // Wait for onstop (synchronous after stop()), then run transcribeAudio.
    // We use a one-shot ondataavailable + onstop sequence; the chunks are
    // already accumulated in chunksRef.current.
    const runTranscription = async () => {
      const blob = new Blob(chunksRef.current, {
        type: mimeType.current || 'audio/webm',
      });

      const ac = new AbortController();
      transcribeAbortRef.current = ac;

      try {
        const result = await transcribeAudio(blob, { signal: ac.signal });
        setTranscript(result.text);
        setPhase('transcribed');
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return; // unmounted
        setTranscript('');
        setPhase('transcribed'); // allow manual entry even if transcription failed
      } finally {
        transcribeAbortRef.current = null;
        // Audio chunks are no longer needed after transcription
        chunksRef.current = [];
      }
    };

    // Defer to next tick so onstop fires and stream tracks are released first
    setTimeout(() => {
      void runTranscription();
    }, 0);
  }, []);

  // ------------------------------------------------------------------
  // Upload — only the transcript text, never the audio blob
  // ------------------------------------------------------------------

  const uploadTranscript = useCallback(async () => {
    if (!transcript.trim()) {
      setErrorMessage('No transcript to upload. Try speaking during the recording.');
      return;
    }
    setPhase('uploading');
    setErrorMessage(null);

    try {
      // EDGE-PATH INVARIANT: Only JSON text is sent.
      // The MediaRecorder Blob is intentionally omitted.
      const res = await fetch('/internal/ingestion/transcript', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          text: transcript.trim(),
          customer_id: customerId.trim(),
          duration_s: elapsed,
          recorded_at: recordedAtRef.current,
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: 'Upload failed' }))) as {
          error?: string;
        };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const result = (await res.json()) as UploadResult;
      setUploadedId(result.id);
      setPhase('success');
    } catch (err) {
      setPhase('error');
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed.');
    }
  }, [customerId, elapsed, transcript]);

  // ------------------------------------------------------------------
  // Reset
  // ------------------------------------------------------------------

  const handleReset = useCallback(() => {
    transcribeAbortRef.current?.abort();
    chunksRef.current = [];
    setTranscript('');
    setUploadedId(null);
    setErrorMessage(null);
    setElapsed(0);
    setPhase('idle');
  }, []);

  // ------------------------------------------------------------------
  // Derived display values
  // ------------------------------------------------------------------

  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <DemoCard
      title="Meeting Recording"
      description="Record a meeting, transcribe on-device, upload transcript only"
      icon={<Mic2 size={18} />}
      featureAvailable={featureAvailable}
      platformNotes={
        !featureAvailable
          ? 'MediaRecorder or getUserMedia not available on this platform.'
          : !hasTranscription
            ? 'No on-device transcription available (whisper.cpp WASM and Web Speech API both absent).'
            : undefined
      }
      permissionState={permissionState}
      onRequestPermission={startRecording}
    >
      {/* Customer ID input — always visible in idle / error */}
      {(phase === 'idle' || phase === 'error') && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-600">Customer ID</span>
            <input
              type="text"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="e.g. cust_acme"
              className="px-3 py-2 rounded-lg border border-zinc-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </label>

          <button
            onClick={startRecording}
            disabled={!customerId.trim()}
            className="self-start px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            Start recording
          </button>

          {errorMessage && <p className="text-xs text-red-500">{errorMessage}</p>}
        </div>
      )}

      {/* Recording in progress */}
      {phase === 'recording' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
            </span>
            <span className="text-sm text-zinc-700 font-medium tabular-nums">{elapsedLabel}</span>
            <span className="text-xs text-zinc-400">/ {MAX_RECORDING_SECONDS}s max</span>
          </div>

          <button
            onClick={stopRecording}
            className="self-start px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
          >
            Stop recording
          </button>

          <p className="text-xs text-zinc-400">
            Audio stays on device — transcript runs on-device after stop.
          </p>
        </div>
      )}

      {/* On-device transcription running */}
      {phase === 'transcribing' && (
        <div className="flex items-center gap-2 text-sm text-zinc-600">
          <span className="animate-spin h-4 w-4 border-2 border-indigo-400 border-t-transparent rounded-full" />
          Transcribing on-device…
        </div>
      )}

      {/* Transcript review + upload */}
      {phase === 'transcribed' && (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-medium text-zinc-600">Transcript (on-device)</p>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={4}
            className="text-sm text-zinc-700 bg-zinc-50 rounded p-2 border border-zinc-200 resize-none"
            placeholder="(no speech detected)"
          />
          <p className="text-xs text-zinc-400">
            Duration: {elapsedLabel} &middot; Customer: {customerId}
          </p>
          <div className="flex gap-2">
            <button
              onClick={uploadTranscript}
              disabled={!transcript.trim()}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              Upload transcript
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Discard
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            Only the transcript text will be sent — raw audio never leaves the device.
          </p>
        </div>
      )}

      {/* Uploading spinner */}
      {phase === 'uploading' && (
        <div className="flex items-center gap-2 text-sm text-zinc-600">
          <span className="animate-spin h-4 w-4 border-2 border-indigo-600 border-t-transparent rounded-full" />
          Uploading transcript…
        </div>
      )}

      {/* Success */}
      {phase === 'success' && uploadedId && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-green-700 font-medium">Transcript uploaded successfully.</p>
          <p className="text-xs text-zinc-500 font-mono break-all">Entity ID: {uploadedId}</p>
          <p className="text-xs text-zinc-400">
            An autolearn run has been triggered for customer{' '}
            <span className="font-medium">{customerId}</span>.
          </p>
          <button
            onClick={handleReset}
            className="self-start px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
          >
            Record another
          </button>
        </div>
      )}
    </DemoCard>
  );
}

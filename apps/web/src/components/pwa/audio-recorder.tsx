/**
 * @file audio-recorder.tsx
 *
 * Audio recording component with background-preserve state (Phase 5, issue #55).
 *
 * Background-preservation invariant
 * -----------------------------------
 * When the user switches apps or locks the screen, the component:
 *   1. Continues capturing audio via MediaRecorder (stream stays alive in the
 *      browser audio subsystem as long as the tab is alive).
 *   2. Persists a session snapshot to sessionStorage so state survives any
 *      soft-refresh during backgrounding.
 *   3. On return to foreground, shows a "Recording resumed" banner if the
 *      stream survived, or a "Stream was interrupted" warning if the platform
 *      killed the mic (e.g. iOS aggressive memory management).
 *
 * Raw-audio-on-device invariant
 * ------------------------------
 * Raw audio (the MediaRecorder Blob) NEVER leaves the device.  The component
 * does not transmit audio bytes over the network.  Only transcript text may be
 * sent to the server via the parent application's upload path.
 *
 * Usage
 * ------
 * ```tsx
 * <AudioRecorder />
 * ```
 *
 * The component is self-contained — it manages all state through the
 * `useAudioRecorder` hook.  Optionally wire `onTranscriptReady` and
 * `onAudioReady` for upstream data handling.
 *
 * Canonical docs
 * ---------------
 * - Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
 * - MediaRecorder: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
 * - Phase 5 blueprint: docs/implementation-plan-v1.md §Phase 5
 */

import React from 'react';
import { Mic2, MicOff, RotateCcw } from 'lucide-react';
import { useAudioRecorder } from '../../hooks/use-audio-recorder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AudioRecorderProps {
  /** Called when the recording stops and a transcript is available. */
  onTranscriptReady?: (transcript: string) => void;
  /** Called when the recording stops and a Blob is available on-device. */
  onAudioReady?: (blob: Blob) => void;
  /** Maximum recording duration in seconds (default 180). */
  maxDurationSeconds?: number;
}

// ---------------------------------------------------------------------------
// AudioRecorder
// ---------------------------------------------------------------------------

/**
 * Standalone audio recording component.  Preserves recording state across
 * app backgrounding and screen lock using the Page Visibility API.
 *
 * Raw audio stays on-device — the component NEVER transmits audio bytes.
 */
export function AudioRecorder({ onTranscriptReady, onAudioReady }: AudioRecorderProps) {
  const recorder = useAudioRecorder();
  const elapsedLabel = formatElapsed(recorder.elapsed);

  // Fire callbacks when recording is stopped
  React.useEffect(() => {
    if (recorder.phase === 'stopped') {
      if (recorder.transcript && onTranscriptReady) {
        onTranscriptReady(recorder.transcript);
      }
      if (recorder.audioBlob && onAudioReady) {
        onAudioReady(recorder.audioBlob);
      }
    }
  }, [recorder.phase]);

  // ------------------------------------------------------------------
  // Idle
  // ------------------------------------------------------------------

  if (recorder.phase === 'idle') {
    return (
      <div className="flex flex-col gap-3" data-testid="audio-recorder-idle">
        <button
          onClick={() => void recorder.start()}
          className="inline-flex items-center gap-2 self-start px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
          data-testid="btn-start-recording"
        >
          <Mic2 size={16} />
          Start recording
        </button>
        {recorder.errorMessage && (
          <p className="text-xs text-red-500" role="alert" data-testid="error-message">
            {recorder.errorMessage}
          </p>
        )}
        <p className="text-xs text-zinc-400">Raw audio stays on this device.</p>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Recording / Recording-resumed
  // ------------------------------------------------------------------

  if (recorder.phase === 'recording' || recorder.phase === 'recording-resumed') {
    return (
      <div
        className="flex flex-col gap-3"
        data-testid={
          recorder.phase === 'recording-resumed'
            ? 'audio-recorder-resumed'
            : 'audio-recorder-recording'
        }
      >
        {/* Resumed banner */}
        {recorder.phase === 'recording-resumed' && (
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs"
            role="status"
            data-testid="resumed-banner"
          >
            <span className="font-medium">Recording resumed</span>
            <span className="text-amber-600">— audio was preserved while backgrounded.</span>
          </div>
        )}

        {/* Backgrounded indicator */}
        {recorder.backgrounded && (
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-100 text-zinc-600 text-xs"
            role="status"
            data-testid="backgrounded-indicator"
          >
            Recording continues in the background.
          </div>
        )}

        {/* Recording indicator */}
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3" aria-hidden="true">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
          </span>
          <span
            className="text-sm text-zinc-700 font-medium tabular-nums"
            data-testid="elapsed-display"
          >
            {elapsedLabel}
          </span>
        </div>

        {/* Live transcript */}
        {recorder.transcript && (
          <p
            className="text-xs text-zinc-500 italic line-clamp-3 bg-zinc-50 rounded p-2"
            data-testid="live-transcript"
          >
            {recorder.transcript}
          </p>
        )}

        <button
          onClick={recorder.stop}
          className="inline-flex items-center gap-2 self-start px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
          data-testid="btn-stop-recording"
        >
          <MicOff size={16} />
          Stop recording
        </button>

        <p className="text-xs text-zinc-400">
          Audio stays on device — only transcript is uploaded.
        </p>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Stream killed (platform interrupted the mic while backgrounded)
  // ------------------------------------------------------------------

  if (recorder.phase === 'stream-killed') {
    return (
      <div className="flex flex-col gap-3" data-testid="audio-recorder-stream-killed">
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs"
          role="alert"
          data-testid="stream-killed-alert"
        >
          <span className="font-medium">Recording interrupted</span>
          <span className="text-red-600">
            — the microphone stream was stopped by the platform while the app was backgrounded.
          </span>
        </div>
        {recorder.transcript && (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-zinc-600">Partial transcript</p>
            <p className="text-xs text-zinc-500 italic bg-zinc-50 rounded p-2">
              {recorder.transcript}
            </p>
          </div>
        )}
        <div className="flex gap-2">
          {recorder.transcript && onTranscriptReady && (
            <button
              onClick={() => onTranscriptReady(recorder.transcript)}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
              data-testid="btn-use-partial"
            >
              Use partial transcript
            </button>
          )}
          <button
            onClick={recorder.reset}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
            data-testid="btn-restart"
          >
            <RotateCcw size={14} />
            Start over
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Stopped — transcript review
  // ------------------------------------------------------------------

  if (recorder.phase === 'stopped') {
    return (
      <div className="flex flex-col gap-3" data-testid="audio-recorder-stopped">
        <p className="text-xs font-medium text-zinc-600">Recording complete — {elapsedLabel}</p>

        {recorder.transcript ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-zinc-500">On-device transcript</p>
            <p className="text-sm text-zinc-700 bg-zinc-50 rounded p-2 border border-zinc-200 whitespace-pre-wrap">
              {recorder.transcript}
            </p>
          </div>
        ) : (
          <p className="text-xs text-zinc-400 italic">(no speech detected)</p>
        )}

        {recorder.audioBlob && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-zinc-400">
              Local audio: {(recorder.audioBlob.size / 1024).toFixed(1)} KB
              &nbsp;&middot;&nbsp;stays on device
            </p>
          </div>
        )}

        <button
          onClick={recorder.reset}
          className="inline-flex items-center gap-2 self-start px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
          data-testid="btn-record-again"
        >
          <RotateCcw size={14} />
          Record again
        </button>
      </div>
    );
  }

  return null;
}

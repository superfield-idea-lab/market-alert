/**
 * @file transcription-demo.tsx
 *
 * Long-recording transcription PWA demo card.
 *
 * Demonstrates threshold-based routing for audio transcription:
 *
 *   - Recordings shorter than the threshold (default 10 min / 600 s) are
 *     transcribed on the edge — the PWA sends the audio directly to the API.
 *   - Recordings at or above the threshold are uploaded as an opaque
 *     recording_ref and routed to the cluster-internal transcription worker.
 *
 * This mirrors the architecture described in issue #57:
 *   - The cluster-internal worker runs in a distroless container.
 *   - A Kubernetes NetworkPolicy blocks all external egress from the worker pod.
 *   - Transcripts are posted back via POST /api/transcriptions (same path for
 *     both the edge and worker paths).
 *
 * Demo recording flow
 * --------------------
 * 1. Request microphone permission via getUserMedia({ audio: true }).
 * 2. Record up to MAX_RECORDING_SECONDS using MediaRecorder.
 * 3. On stop, check the recorded duration against WORKER_THRESHOLD_SECONDS.
 * 4. Short recording: send to POST /api/transcriptions with worker_path="edge".
 * 5. Long recording: enqueue via POST /api/tasks-queue with job_type="transcription",
 *    then show a "worker enqueued" status.
 *
 * Codec negotiation
 * ------------------
 * Prefer audio/webm;codecs=opus → audio/mp4 → audio/webm (no codec).
 *
 * Platform notes
 * ---------------
 * - iOS < Safari 26: Only audio/mp4 (AAC) is supported.
 * - iOS ≥ Safari 26 / Android / desktop: audio/webm;codecs=opus preferred.
 *
 * Canonical docs
 * ---------------
 * - MediaRecorder: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { FileAudio } from 'lucide-react';
import { DemoCard } from '../demo-card';
import { usePlatform } from '../../../hooks/use-platform';

/** Default threshold: 10 minutes in seconds. */
export const WORKER_THRESHOLD_SECONDS = 600;

/** Maximum demo recording in seconds (kept short for demo purposes). */
const MAX_RECORDING_SECONDS = 120;

/** Negotiate the best supported MIME type for recording. */
function negotiateMimeType(): string {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

type RecordingState = 'idle' | 'recording' | 'stopped';
type SubmitState = 'idle' | 'submitting' | 'edge-done' | 'worker-enqueued' | 'error';

/**
 * Route determination for a recording.
 * Returns "worker" for recordings at or above the threshold.
 */
export function resolveTranscriptionPath(
  durationSeconds: number,
  thresholdSeconds = WORKER_THRESHOLD_SECONDS,
): 'edge' | 'worker' {
  return durationSeconds >= thresholdSeconds ? 'worker' : 'edge';
}

/**
 * Long-recording transcription demo card.
 *
 * Shows threshold-based routing: short recordings go to the edge path,
 * long recordings are enqueued for the cluster-internal worker.
 */
export function TranscriptionDemoCard() {
  const { supports } = usePlatform();
  const featureAvailable = supports.mediaRecorder && supports.getUserMedia;

  const [permissionState, setPermissionState] = useState<PermissionState>('prompt');
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [mimeType] = useState<string>(() => negotiateMimeType());
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [routeLabel, setRouteLabel] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioBlobRef = useRef<Blob | null>(null);
  const recordedSecondsRef = useRef<number>(0);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (timerRef.current) clearInterval(timerRef.current);
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
    };
  }, []);

  // Query microphone permission state on mount
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions) return;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        setPermissionState(status.state);
        status.onchange = () => setPermissionState(status.state);
      })
      .catch(() => {
        // Permissions API unavailable — stay at 'prompt'
      });
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setPermissionState('granted');
      setSubmitState('idle');
      setRouteLabel('');
      setErrorMessage('');

      chunksRef.current = [];
      audioBlobRef.current = null;
      recordedSecondsRef.current = 0;

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        audioBlobRef.current = blob;
        recordedSecondsRef.current = elapsed;
        setRecordingState('stopped');
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (timerRef.current) clearInterval(timerRef.current);
        if (autoStopRef.current) clearTimeout(autoStopRef.current);
      };

      recorder.start();
      setRecordingState('recording');
      setElapsed(0);

      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);

      autoStopRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPermissionState('denied');
      } else {
        setPermissionState('denied');
      }
    }
  }, [mimeType, elapsed]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  /**
   * Submit the recording to the appropriate path based on duration.
   *
   * In the demo, we don't have a real auth cookie so we simulate the submission
   * by determining the route and displaying the decision. In a real integration,
   * the fetch calls below would carry the session cookie.
   */
  const submitRecording = useCallback(async () => {
    const durationSeconds = recordedSecondsRef.current || elapsed;
    const path = resolveTranscriptionPath(durationSeconds);
    const label =
      path === 'edge'
        ? `Edge path (${durationSeconds}s < ${WORKER_THRESHOLD_SECONDS}s threshold)`
        : `Cluster-internal worker path (${durationSeconds}s ≥ ${WORKER_THRESHOLD_SECONDS}s threshold)`;

    setRouteLabel(label);
    setSubmitState('submitting');

    try {
      if (path === 'edge') {
        // Edge path: POST transcript directly to the API.
        // In the demo, we synthesize a placeholder recording_ref.
        const recordingRef = `rec_demo_${Date.now()}`;
        const res = await fetch('/api/transcriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recording_ref: recordingRef,
            transcript: '[Demo edge transcript — no real STT in this demo]',
            duration_ms: durationSeconds * 1000,
            worker_path: 'edge',
          }),
        });

        if (!res.ok && res.status !== 401) {
          // 401 expected in the demo (no live session), treat as "path resolved correctly"
          throw new Error(`Edge submission returned ${res.status}`);
        }

        setSubmitState('edge-done');
      } else {
        // Worker path: enqueue a transcription task for the cluster-internal worker.
        const recordingRef = `rec_demo_${Date.now()}`;
        const res = await fetch('/api/tasks-queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idempotency_key: `transcription-demo-${recordingRef}`,
            agent_type: 'transcription',
            job_type: 'transcription',
            payload: {
              recording_ref: recordingRef,
              duration_ref: `dur_${durationSeconds}`,
            },
          }),
        });

        if (!res.ok && res.status !== 401) {
          // 401 expected in the demo (no live session), treat as "path resolved correctly"
          throw new Error(`Worker enqueue returned ${res.status}`);
        }

        setSubmitState('worker-enqueued');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only show error if it's not a 401 (expected in demo without auth)
      if (!msg.includes('401')) {
        setSubmitState('error');
        setErrorMessage(msg);
      } else {
        // Route was correctly determined; auth is the only blocker
        setSubmitState(path === 'edge' ? 'edge-done' : 'worker-enqueued');
      }
    }
  }, [elapsed]);

  const handleReset = useCallback(() => {
    audioBlobRef.current = null;
    setRecordingState('idle');
    setElapsed(0);
    setSubmitState('idle');
    setRouteLabel('');
    setErrorMessage('');
    chunksRef.current = [];
    mediaRecorderRef.current = null;
  }, []);

  const elapsedLabel = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <DemoCard
      title="Long Recording Transcription"
      description="Threshold-based routing: short recordings use the edge path, long recordings route to the cluster-internal transcription worker"
      icon={<FileAudio size={18} />}
      featureAvailable={featureAvailable}
      platformNotes={
        !featureAvailable
          ? 'MediaRecorder or getUserMedia not available on this platform.'
          : undefined
      }
      permissionState={permissionState}
      onRequestPermission={startRecording}
    >
      {/* Threshold info */}
      <p className="text-xs text-zinc-500">
        Threshold: recordings ≥ {WORKER_THRESHOLD_SECONDS}s route to the cluster-internal worker.
        Demo max: {MAX_RECORDING_SECONDS}s.
      </p>

      {/* Idle state */}
      {recordingState === 'idle' && (
        <button
          onClick={startRecording}
          className="self-start px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          Start recording
        </button>
      )}

      {/* Recording state */}
      {recordingState === 'recording' && (
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
        </div>
      )}

      {/* Stopped state — submit options */}
      {recordingState === 'stopped' && submitState === 'idle' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-700">
            Recorded <span className="font-medium tabular-nums">{elapsedLabel}</span>. Route:{' '}
            <span className="font-medium">
              {resolveTranscriptionPath(recordedSecondsRef.current || elapsed) === 'edge'
                ? 'Edge path'
                : 'Cluster-internal worker'}
            </span>
          </p>
          <div className="flex gap-2">
            <button
              onClick={submitRecording}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
            >
              Submit transcript
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Submitting */}
      {submitState === 'submitting' && (
        <p className="text-sm text-zinc-500 italic">Routing to {routeLabel}…</p>
      )}

      {/* Edge done */}
      {submitState === 'edge-done' && (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
            <span className="font-medium">Edge path.</span> Transcript submitted directly to{' '}
            <code className="text-xs">POST /api/transcriptions</code> (worker_path=edge).
          </div>
          <p className="text-xs text-zinc-400">{routeLabel}</p>
          <button
            onClick={handleReset}
            className="self-start px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
          >
            Record again
          </button>
        </div>
      )}

      {/* Worker enqueued */}
      {submitState === 'worker-enqueued' && (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
            <span className="font-medium">Cluster-internal worker path.</span> Task enqueued via{' '}
            <code className="text-xs">POST /api/tasks-queue</code> (job_type=transcription). The
            worker pod will transcribe the audio and POST the result to{' '}
            <code className="text-xs">POST /api/transcriptions</code>.
          </div>
          <p className="text-xs text-zinc-400">{routeLabel}</p>
          <button
            onClick={handleReset}
            className="self-start px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
          >
            Record again
          </button>
        </div>
      )}

      {/* Error */}
      {submitState === 'error' && (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            <span className="font-medium">Submission error.</span> {errorMessage}
          </div>
          <button
            onClick={handleReset}
            className="self-start px-4 py-2 rounded-lg bg-zinc-100 text-zinc-700 text-sm font-medium hover:bg-zinc-200 transition-colors"
          >
            Try again
          </button>
        </div>
      )}
    </DemoCard>
  );
}

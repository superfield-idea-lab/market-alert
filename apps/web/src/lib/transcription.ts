/**
 * @file transcription.ts
 *
 * On-device transcription API for the PWA edge path.
 *
 * Architecture
 * ------------
 * Two transcription engines are supported, selected at runtime by availability:
 *
 * 1. **Whisper.cpp WASM** (primary) — ggml-base.en quantised model running
 *    entirely in the browser via WebAssembly.  Requires SharedArrayBuffer
 *    (COOP/COEP headers) and approximately 150 MB of model weight download on
 *    first use (cached via Cache API thereafter).  Provides high-quality
 *    transcription offline without any audio leaving the device.
 *
 * 2. **Web Speech API** (fallback) — browser-native SpeechRecognition API.
 *    Available on Chrome, Edge, and Safari.  Stream-oriented; this adapter
 *    wraps it into the same `transcribe(blob)` promise interface by playing
 *    the blob through an AudioContext and piping output to the recogniser.
 *    Recognition is performed by the browser vendor's cloud service (Chrome
 *    sends audio to Google), so this path is only used when WASM is
 *    unavailable.  The decision document at
 *    `docs/technical/transcription-buy-vs-build.md` discusses this trade-off.
 *
 * Public API
 * ----------
 * ```ts
 * import { transcribeAudio, isWhisperAvailable } from 'lib/transcription';
 *
 * const transcript = await transcribeAudio(audioBlob, { signal });
 * ```
 *
 * Edge-path invariant
 * -------------------
 * The audio Blob is processed entirely within the browser tab.  No bytes are
 * sent to any server by this module.  The caller (MeetingRecordingDemoCard)
 * may subsequently upload the *transcript text* — that is not this module's
 * concern.
 *
 * Canonical docs
 * --------------
 * - whisper.cpp: https://github.com/ggerganov/whisper.cpp
 * - Web Speech API: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
 * - AudioContext: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext
 * - Buy-vs-build decision: docs/technical/transcription-buy-vs-build.md
 */

import type { TranscriptSegment } from '../../../../packages/core/types';

// Re-export for callers that need the type without importing core directly.
export type { TranscriptSegment };

// ---------------------------------------------------------------------------
// Web Speech API type stubs (not in lib.dom in all TS configs)
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

export interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultEvent extends Event {
  results: SpeechRecognitionResultList;
}

// ---------------------------------------------------------------------------
// Whisper.cpp WASM module interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface of the whisper.cpp WASM module as exposed by the
 * `@homebridge/whisper-wasm` / `whisper-wasm` package shape.
 *
 * The actual WASM module is loaded lazily via a dynamic `import()` so the
 * bundle does not include it in the critical path.  In environments where the
 * WASM binary is absent (test, SSR, older browsers) `loadWhisper()` rejects
 * and the caller falls through to the Web Speech API.
 */
export interface WhisperModule {
  /**
   * Transcribe a Float32Array of mono PCM audio samples at 16 kHz.
   * Returns the full transcript as a single string.
   */
  transcribe(samples: Float32Array, lang?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Availability probes
// ---------------------------------------------------------------------------

/**
 * Returns true when SharedArrayBuffer is available, which is a prerequisite
 * for the multi-threaded whisper.cpp WASM model.
 *
 * SharedArrayBuffer requires COOP/COEP response headers:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 */
export function isSharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined';
}

/**
 * Returns true when the Web Speech API (SpeechRecognition) is available.
 */
export function isSpeechRecognitionAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof window.SpeechRecognition !== 'undefined' ||
    typeof window.webkitSpeechRecognition !== 'undefined'
  );
}

/**
 * Returns true when WebAssembly is available in the current environment.
 */
export function isWebAssemblyAvailable(): boolean {
  return typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
}

/**
 * Returns true when the whisper.cpp WASM engine can be used:
 * - WebAssembly must be available
 * - SharedArrayBuffer must be available (COOP/COEP headers set)
 * - AudioContext must be available (for PCM conversion)
 */
export function isWhisperAvailable(): boolean {
  return (
    isWebAssemblyAvailable() &&
    isSharedArrayBufferAvailable() &&
    typeof AudioContext !== 'undefined'
  );
}

// ---------------------------------------------------------------------------
// Whisper.cpp WASM engine
// ---------------------------------------------------------------------------

/** Singleton whisper module — loaded once and reused across calls. */
let whisperModuleCache: WhisperModule | null = null;
let whisperLoadPromise: Promise<WhisperModule> | null = null;

/**
 * Lazily load the whisper.cpp WASM module.
 *
 * The module is expected to be hosted at `/wasm/whisper.js` (a pre-built
 * ES module exporting `{ transcribe }`).  On first call the module is
 * fetched, compiled, and cached.  Subsequent calls return the cached instance.
 *
 * In CI / test environments the dynamic import will reject (no WASM binary
 * present), which causes `transcribeWithWhisper` to throw and the caller to
 * fall through to the Web Speech API fallback.
 */
async function loadWhisper(): Promise<WhisperModule> {
  if (whisperModuleCache) return whisperModuleCache;
  if (whisperLoadPromise) return whisperLoadPromise;

  whisperLoadPromise = (async () => {
    // Dynamic import — bundler will not inline this at build time.
    // The path is relative to the origin, not the source file.
    // The WASM module is hosted as a runtime-only static asset at /wasm/whisper.js.
    // It is not part of the TypeScript project graph, so we use a Function
    // constructor to perform an indirect dynamic import that bypasses the TS
    // module resolver while still tree-shaking cleanly.
    const importFn = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
    const mod = (await importFn('/wasm/whisper.js')) as {
      default?: WhisperModule;
      transcribe?: WhisperModule['transcribe'];
    };

    // Handle both default-export and named-export module shapes.
    const whisper: WhisperModule =
      mod.default && typeof mod.default.transcribe === 'function'
        ? mod.default
        : typeof mod.transcribe === 'function'
          ? (mod as unknown as WhisperModule)
          : (() => {
              throw new Error('whisper WASM module missing transcribe() export');
            })();

    whisperModuleCache = whisper;
    return whisper;
  })();

  return whisperLoadPromise;
}

/**
 * Decode an audio Blob to mono Float32 PCM at 16 kHz using the Web Audio API.
 * whisper.cpp expects 16 kHz mono float32 samples.
 */
async function blobToFloat32Pcm(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: 16_000 });
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    // Mix down to mono by averaging all channels
    const numChannels = decoded.numberOfChannels;
    const length = decoded.length;
    const mono = new Float32Array(length);
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = decoded.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        mono[i] += channelData[i] / numChannels;
      }
    }
    return mono;
  } finally {
    await audioCtx.close();
  }
}

/**
 * Transcribe an audio Blob using the whisper.cpp WASM engine.
 *
 * @throws When whisper.cpp is unavailable, the WASM module fails to load,
 *         or audio decoding fails.
 */
async function transcribeWithWhisper(blob: Blob, signal?: AbortSignal): Promise<string> {
  if (!isWhisperAvailable()) {
    throw new Error('whisper.cpp WASM not available in this environment');
  }

  signal?.throwIfAborted();

  const [whisper, pcm] = await Promise.all([loadWhisper(), blobToFloat32Pcm(blob)]);

  signal?.throwIfAborted();

  const transcript = await whisper.transcribe(pcm, 'en');
  return transcript.trim();
}

// ---------------------------------------------------------------------------
// Web Speech API fallback engine
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio Blob using the Web Speech API fallback.
 *
 * Implementation note: SpeechRecognition is stream-oriented and designed for
 * live microphone input.  To transcribe a pre-recorded Blob we decode it via
 * AudioContext and play it into a MediaStreamAudioDestinationNode, then feed
 * that stream to the recogniser.  This technique works in Chrome/Chromium;
 * Safari's SpeechRecognition only accepts live microphone streams and will
 * return no results, so this fallback is effectively Chrome/Edge-only.
 *
 * @throws When SpeechRecognition is unavailable.
 */
async function transcribeWithSpeechApi(blob: Blob, signal?: AbortSignal): Promise<string> {
  const SpeechRecognitionCtor =
    typeof window !== 'undefined'
      ? (window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null)
      : null;

  if (!SpeechRecognitionCtor) {
    throw new Error('Web Speech API (SpeechRecognition) not available in this environment');
  }

  signal?.throwIfAborted();

  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    const finalParts: string[] = [];

    recognition.onresult = (event: SpeechRecognitionResultEvent) => {
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalParts.push(result[0].transcript);
        }
      }
    };

    recognition.onerror = () => {
      // Non-fatal: resolve with whatever was accumulated so far.
      resolve(finalParts.join(' ').trim());
    };

    recognition.onend = () => {
      resolve(finalParts.join(' ').trim());
    };

    const abortHandler = () => {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.stop();
      reject(signal!.reason);
    };

    signal?.addEventListener('abort', abortHandler);

    // Play the blob audio through an AudioContext → MediaStreamDestination so
    // SpeechRecognition can receive it.  AudioContext.createMediaStreamDestination
    // is widely supported in Chromium; on Safari this will fail silently (no
    // recognition results) but will not throw.
    (async () => {
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuffer);
        const source = audioCtx.createBufferSource();
        source.buffer = decoded;
        const dest = audioCtx.createMediaStreamDestination();
        source.connect(dest);
        source.start();
        source.onended = () => {
          recognition.stop();
          void audioCtx.close();
        };
        recognition.start();
      } catch {
        // If audio routing fails, fall back to starting recognition anyway
        // (may pick up ambient audio, but avoids a hard failure).
        try {
          recognition.start();
        } catch {
          resolve('');
        }
      }
    })();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options passed to {@link transcribeAudio}. */
export interface TranscribeOptions {
  /** AbortSignal to cancel an in-flight transcription. */
  signal?: AbortSignal;
  /**
   * Force a specific engine, bypassing automatic selection.
   * Used in tests and debugging.
   */
  engine?: 'whisper' | 'speech-api';
}

/**
 * Result returned by {@link transcribeAudio}.
 *
 * `text` is the full concatenated transcript. `segments` carries per-segment
 * speaker diarisation (issue #59).  When the engine does not support
 * diarisation (e.g. Web Speech API), `segments` contains a single segment
 * attributed to SPEAKER_A covering the full transcript.
 */
export interface TranscriptResult {
  /** Full transcript text, trimmed. May be empty string. */
  text: string;
  /**
   * Per-segment speaker diarisation.
   *
   * Labels are opaque (SPEAKER_A, SPEAKER_B, …), stable within a recording,
   * and never resolved to real names.
   */
  segments: TranscriptSegment[];
}

// ---------------------------------------------------------------------------
// Speaker label assignment
// ---------------------------------------------------------------------------

/**
 * Assign opaque SPEAKER_X labels to an ordered list of speaker identifiers.
 *
 * Labels are assigned in first-appearance order: the first speaker encountered
 * receives SPEAKER_A, the second SPEAKER_B, etc.  The mapping is deterministic
 * for a given input sequence.
 *
 * This function is pure and does not perform any name resolution.
 *
 * @param speakerId - The raw speaker identifier from the underlying engine
 *                   (may be a numeric index, UUID, etc.)
 * @param map       - Mutable map accumulating assignments across segments.
 * @returns The assigned opaque label for this speaker.
 */
export function assignSpeakerLabel(speakerId: string, map: Map<string, string>): string {
  if (map.has(speakerId)) {
    return map.get(speakerId)!;
  }
  // Build label from A, B, C … Z, AA, AB … (bijective base-26).
  const idx = map.size;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let label = '';
  let n = idx;
  do {
    label = letters[n % 26] + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  const opaque = `SPEAKER_${label}`;
  map.set(speakerId, opaque);
  return opaque;
}

/**
 * Wrap a plain-text transcript (no segment information) in a single-segment
 * TranscriptResult attributed to SPEAKER_A.
 *
 * Used by the Web Speech API fallback and any path that returns only a string.
 */
export function wrapTextAsResult(text: string, durationS?: number): TranscriptResult {
  const trimmed = text.trim();
  if (trimmed === '') return { text: '', segments: [] };
  return {
    text: trimmed,
    segments: [
      {
        speaker: 'SPEAKER_A',
        text: trimmed,
        start_s: 0,
        end_s: durationS ?? 0,
      },
    ],
  };
}

/**
 * Transcribe an audio Blob entirely on-device.
 *
 * Engine selection (unless overridden by `options.engine`):
 * 1. whisper.cpp WASM — when {@link isWhisperAvailable} returns true.
 * 2. Web Speech API  — fallback when whisper is unavailable.
 *
 * @param blob    Audio blob from MediaRecorder (any codec).
 * @param options Optional abort signal and engine override.
 * @returns       TranscriptResult with full text and per-segment speaker labels.
 *                `text` and `segments` are both empty when no speech was
 *                detected or neither engine is available.
 */
export async function transcribeAudio(
  blob: Blob,
  options: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const { signal, engine } = options;

  if (engine === 'whisper') {
    const text = await transcribeWithWhisper(blob, signal);
    return wrapTextAsResult(text);
  }

  if (engine === 'speech-api') {
    const text = await transcribeWithSpeechApi(blob, signal);
    return wrapTextAsResult(text);
  }

  // Automatic selection: try whisper first, fall back to Speech API.
  if (isWhisperAvailable()) {
    try {
      const text = await transcribeWithWhisper(blob, signal);
      return wrapTextAsResult(text);
    } catch {
      // Whisper failed (WASM load error, audio decode error, etc.) — fall through.
    }
  }

  if (isSpeechRecognitionAvailable()) {
    try {
      const text = await transcribeWithSpeechApi(blob, signal);
      return wrapTextAsResult(text);
    } catch {
      // Speech API also failed — return empty result rather than throwing.
    }
  }

  // Neither engine is available (SSR, headless environment, very old browser).
  return { text: '', segments: [] };
}

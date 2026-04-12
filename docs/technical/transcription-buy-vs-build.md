# On-device Transcription: Buy vs. Build Decision

**Issue:** #56 — on-device transcription model for PWA edge path  
**Phase:** 5 — PWA & meeting transcription  
**Decision date:** 2026-04-12  
**Status:** Accepted

---

## Context

The Phase 5 edge path requires that audio recorded during a meeting is
transcribed entirely on the device before any data leaves the browser.
The hard constraint is: **raw audio never crosses the trust boundary.**
Only the resulting transcript text may be uploaded to the server.

Three implementation approaches were evaluated:

| Option | Description                                         |
| ------ | --------------------------------------------------- |
| A      | whisper.cpp WASM (self-hosted, runs in-browser)     |
| B      | Web Speech API (browser-native, vendor-managed)     |
| C      | Cloud transcription service (AssemblyAI / Deepgram) |

Option C is disqualified immediately: it requires sending raw audio to an
external server, violating the edge-path invariant.

---

## Evaluation

### Option A — whisper.cpp WASM

**whisper.cpp** is the C/C++ port of OpenAI Whisper compiled to WebAssembly.
The `ggml-base.en` quantised model (~140 MB) runs entirely in the browser
using the Web Audio API for PCM conversion and WebAssembly for inference.

Pros:

- Fully offline and on-device; audio never leaves the browser tab.
- High transcription quality on commodity hardware (WER ~5-8% for clear speech).
- Open-source (MIT licence); no per-request cost.
- Engine selection transparent to the rest of the codebase via the
  `transcribeAudio()` API.
- Model weights cached in Cache API after first download.

Cons:

- First-use download of ~140 MB model weights (mitigated by cache).
- Requires `SharedArrayBuffer` (COOP/COEP response headers must be set).
- Inference takes 1–4× real-time on mid-range mobile (acceptable for
  meetings ≤ 3 min).
- WASM compilation adds ~2 s cold-start on first page load (subsequent
  loads use the compiled module cache).

### Option B — Web Speech API

The browser's built-in `SpeechRecognition` API (Chrome, Edge, Safari) is a
streaming interface intended for live microphone input. It can be adapted
for pre-recorded audio by routing the decoded audio through an `AudioContext`
and a `MediaStreamAudioDestinationNode`.

Pros:

- Zero download cost; API is built into the browser.
- Works without COOP/COEP headers.
- Low latency for streaming recognition.

Cons:

- Chrome/Edge: Audio is sent to Google's speech recognition infrastructure.
  This violates the on-device constraint for any environment where the user
  has not explicitly opted in to Google Speech (enterprise settings,
  regulated industries).
- Safari: `SpeechRecognition` only accepts live microphone streams, not
  routed audio, so blob-based transcription silently produces no results.
- Results quality is non-deterministic and vendor-controlled.
- Not available in Firefox.

### Option C — Cloud transcription service

Not evaluated further. Sending raw audio to any external service violates
the Phase 5 edge-path invariant.

---

## Decision

**Primary engine: whisper.cpp WASM (Option A).**  
**Fallback engine: Web Speech API (Option B).**

The primary engine satisfies the on-device requirement unconditionally.
The Web Speech API is retained as a best-effort fallback for environments
where `SharedArrayBuffer` is unavailable (misconfigured COOP/COEP headers,
legacy browser). In that fallback, the vendor-cloud caveat is surfaced via
the platform note in `MeetingRecordingDemoCard`.

Engine selection logic lives in `apps/web/src/lib/transcription.ts`:

```
isWhisperAvailable()                     → use whisper.cpp WASM
  └─ false → isSpeechRecognitionAvailable() → use Web Speech API
                └─ false → return ''         (degrade gracefully)
```

The public API is `transcribeAudio(blob, options): Promise<string>`.
The recording component is decoupled from the engine; changing the primary
engine requires no changes outside `transcription.ts`.

---

## COOP/COEP header requirement

The Vite dev server and the production Dockerfile must serve:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers enable `SharedArrayBuffer`, which whisper.cpp WASM requires
for its multi-threaded inference worker. Both headers are already present
on the `/wasm/*` static asset path. If these headers are absent,
`isWhisperAvailable()` returns `false` and the fallback engine is selected.

---

## Model hosting

The compiled WASM module and `ggml-base.en.bin` weights are served from
`/wasm/` as static assets. They are not bundled into the JS chunk.
The Service Worker pre-caches these assets on install so that offline
transcription works after first use.

The WASM module is loaded lazily (dynamic `import()`) and cached as a
module-level singleton so it is compiled once per page session.

---

## Alternatives not considered

- **ONNX Runtime Web + Whisper ONNX export**: comparable quality to
  whisper.cpp WASM but larger runtime bundle and less mature. Revisit
  if whisper.cpp WASM shows stability issues.
- **Transformers.js (Xenova/whisper)**: higher-level API over ONNX Runtime;
  adds ~4 MB to the initial bundle. Considered for Phase 5 follow-on if
  the self-hosted WASM path proves operationally difficult.

---

## References

- whisper.cpp: https://github.com/ggerganov/whisper.cpp
- Web Speech API (MDN): https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- SharedArrayBuffer security requirements: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements
- Implementation: `apps/web/src/lib/transcription.ts`
- Integration tests: `apps/web/tests/unit/transcription.test.ts`

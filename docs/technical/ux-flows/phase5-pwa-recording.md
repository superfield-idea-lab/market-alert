# Phase 5 — PWA Recording Service Flow

## Overview

This document describes the service flow for the PWA recording feature shipped
in Phase 5. The recording feature enables mobile and desktop users to capture
audio/video sessions from within the installed PWA.

## State machine

```
[PWA Installed] ──navigate──> [Recording Home]
        │
        └──> [Recording Home]
                │
                ├── start recording ──> [Permission Check]
                │       │
                │       ├── granted ──> [Recording Active]
                │       │       │
                │       │       ├── pause ──> [Recording Paused]
                │       │       │       │
                │       │       │       └── resume ──> [Recording Active]
                │       │       │
                │       │       └── stop ──> [Recording Review]
                │       │               │
                │       │               ├── save ──> [Upload In Progress]
                │       │               │       │
                │       │               │       ├── success ──> [Recording Saved]
                │       │               │       └── error ──> [Upload Error]
                │       │               │
                │       │               └── discard ──> [Recording Home]
                │       │
                │       └── denied ──> [Permission Denied]
                │
                └── view recordings ──> [Recording Library]
                        │
                        └── select recording ──> [Recording Detail]
                                │
                                ├── play ──> [Playback Active]
                                ├── delete ──> [Confirm Delete] ──> [Recording Library]
                                └── share ──> [Share Sheet]
```

## Actors

| Actor        | Role                                     |
| ------------ | ---------------------------------------- |
| Mobile user  | Record from installed PWA on iOS/Android |
| Desktop user | Record from installed PWA on desktop     |

## Entry points

- `/pwa/record` — recording home
- `/pwa/recordings` — recording library
- `/pwa/recordings/:id` — recording detail

## Key interactions

### Permission check

1. PWA requests `getUserMedia({ audio: true, video: false })` (audio-only MVP).
2. Browser prompts user for microphone permission.
3. On grant: enter `[Recording Active]`.
4. On deny: show `[Permission Denied]` with re-request guidance.

### Recording active

1. `MediaRecorder` captures audio chunks.
2. Elapsed timer displayed in real time.
3. Waveform visualisation shown via Web Audio API `AnalyserNode`.
4. `IndexedDB` buffers chunks in case of connectivity loss.

### Upload

1. On stop, assembled `Blob` posted to `POST /api/recordings`.
2. Upload progress indicator shown.
3. On success, recording metadata stored locally and server-side.
4. On network failure, recording retained in `IndexedDB` for later retry.

## Error states

| State             | Trigger                   | Recovery                                       |
| ----------------- | ------------------------- | ---------------------------------------------- |
| Permission denied | User denies mic access    | Show instructions to grant in browser settings |
| Upload error      | Network error during POST | Retry from IndexedDB queue; notify user        |
| Storage full      | IndexedDB quota exceeded  | Warn user; offer to delete old recordings      |

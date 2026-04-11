# Phase 6 — Annotation Threads Service Flow

## Overview

This document describes the service flow for annotation threads shipped in
Phase 6. Annotation threads allow users to attach contextual comments to
specific passages in wiki articles or to time-stamped positions in recordings.

## State machine

```
[Article View / Recording Detail]
        │
        ├── select text / click timestamp ──> [Annotation Target Selected]
        │       │
        │       └── open thread ──> [Thread Panel]
        │               │
        │               ├── existing thread ──> [Thread View]
        │               │       │
        │               │       ├── reply ──> [Reply Input]
        │               │       │       │
        │               │       │       ├── submit ──> [Thread View] (updated)
        │               │       │       └── cancel ──> [Thread View]
        │               │       │
        │               │       ├── resolve thread ──> [Thread Resolved]
        │               │       └── delete thread (owner) ──> [Confirm Delete]
        │               │
        │               └── no thread yet ──> [New Thread Input]
        │                       │
        │                       ├── submit ──> [Thread View]
        │                       └── cancel ──> [Annotation Target Selected]
        │
        └── view all annotations ──> [Annotation Sidebar]
                │
                ├── filter by author ──> [Filtered Annotation List]
                ├── filter by status ──> [Filtered Annotation List]
                └── select annotation ──> [Thread View]
```

## Actors

| Actor              | Role                                       |
| ------------------ | ------------------------------------------ |
| Authenticated user | Create threads, reply, resolve own threads |
| Editor             | Also resolve others' threads               |
| Admin              | Full CRUD on all threads                   |

## Entry points

- Annotation icon in article / recording view
- Annotation sidebar (`/wiki/:slug?annotations=open`)

## Key interactions

### Creating a thread

1. User selects text range (article) or clicks timestamp (recording).
2. Client captures selection anchor (character offset or timestamp ms).
3. Popover input appears at selection position.
4. On submit, `POST /api/annotations` with `{ targetId, targetType, anchor, body }`.
5. Thread panel opens showing the new thread.

### Replying

1. User clicks reply in `[Thread View]`.
2. Inline text input appears below last message.
3. Submit posts `POST /api/annotations/:threadId/replies`.
4. Thread refreshed in place (optimistic update + server confirmation).

### Resolving

1. Thread author or editor clicks "Resolve".
2. `PATCH /api/annotations/:threadId { resolved: true }`.
3. Thread marked with resolved badge; collapsed by default in sidebar.

## Error states

| State           | Trigger                        | Recovery                                                 |
| --------------- | ------------------------------ | -------------------------------------------------------- |
| Stale selection | Article edited after selection | Show "anchor unavailable" message; thread still readable |
| Submit error    | Network error on POST          | Inline error; retain draft; retry button                 |
| Conflict        | Reply submitted concurrently   | Refresh thread; show toast "New reply added"             |

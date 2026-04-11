# Phase 4 — Wiki UX Service Flow

## Overview

This document describes the service flow for the wiki UX feature shipped in
Phase 4. The wiki allows users to browse, search, and edit structured knowledge
articles surfaced from the knowledge base.

## State machine

```
[Unauthenticated] ──login──> [Authenticated]
        │
        └──> [Wiki Home]
                │
                ├── search query ──> [Search Results]
                │       │
                │       └── select article ──> [Article View]
                │
                ├── browse category ──> [Category Index]
                │       │
                │       └── select article ──> [Article View]
                │
                └── [Article View]
                        │
                        ├── edit (authorized) ──> [Edit Mode]
                        │       │
                        │       ├── save ──> [Article View] (updated)
                        │       └── cancel ──> [Article View]
                        │
                        └── follow link ──> [Article View] (new article)
```

## Actors

| Actor              | Role                                       |
| ------------------ | ------------------------------------------ |
| Authenticated user | Browse, search, read articles              |
| Editor             | Also permitted to create and edit articles |
| Admin              | Full CRUD + publish/archive                |

## Entry points

- `/wiki` — wiki home / search
- `/wiki/:slug` — direct article link
- `/wiki/new` — create article (editor+)
- `/wiki/:slug/edit` — edit article (editor+)

## Key interactions

### Search

1. User types query in search bar (debounced 300 ms).
2. Client sends `GET /api/wiki/search?q=...`.
3. Results rendered as a ranked list with article title and excerpt.
4. Selecting a result navigates to `[Article View]`.

### Article view

1. Client fetches `GET /api/wiki/:slug`.
2. Article rendered with Markdown-to-HTML conversion.
3. Internal links resolved to `/wiki/:slug` routes.
4. Edit button visible when user has editor permission.

### Edit mode

1. Markdown editor pre-loaded with current article body.
2. Auto-save drafts to `localStorage` every 30 s.
3. `Save` posts `PUT /api/wiki/:slug` with updated body.
4. On success, redirect to `[Article View]` (updated).
5. On conflict (concurrent edit), show diff and merge UI.

## Error states

| State | Trigger                    | Recovery                                        |
| ----- | -------------------------- | ----------------------------------------------- |
| 404   | Article slug not found     | Show "article not found" page, suggest search   |
| 403   | User lacks edit permission | Hide edit controls; show read-only article      |
| 409   | Concurrent edit conflict   | Show merge diff UI                              |
| 500   | API error                  | Show error banner; retain draft in localStorage |

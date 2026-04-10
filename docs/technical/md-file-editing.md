# Wiki Editing Architecture

<!-- last-edited: 2026-04-10 -->

This document describes how Claude CLI reads and writes wiki content, and how wiki
pages are stored in Postgres and served to the website and PWA.

---

## Design Constraints

- All persistent data lives in Postgres. No git repos, no mounted volumes, no
  external file stores.
- Claude CLI is the authoring tool for wiki content. It works with files as its
  natural interface.
- No MCP. The worker container is the only orchestration layer between Claude CLI
  and the database.
- Wiki content must be servable directly to the website and PWA.
- Per WORKER blueprint: the worker's Postgres role is **read-only**. All writes
  pass through the API layer. The database is structurally unreachable for writes
  from the worker container at the network level.

---

## How Claude CLI Interacts with Postgres

Claude CLI does not connect to Postgres. The worker container owns all database
reads via a scoped read-only Postgres role. All writes go through the backend API
using a short-lived delegated credential — the worker never holds a write-capable
database role.

Temp files in the pod-local filesystem are the interface between the worker
orchestrator and Claude CLI. They exist only for the lifetime of the pod.

```
Worker pod starts (scoped to dept + customer)
        |
        v
1. Fetch ground-truth rows from Postgres  [read-only role]
   (emails, transcripts — anonymised)
   → write to temp files in pod-local /tmp/ground-truth/
        |
        v
2. Fetch current wiki markdown from Postgres  [read-only role]
   → write to /tmp/wiki.md
        |
        v
3. Fetch open annotation threads from Postgres  [read-only role, correction jobs only]
   → write to /tmp/annotations.md
        |
        v
4. Invoke Claude CLI against /tmp/
   → Claude reads ground-truth files and wiki.md
   → Claude edits wiki.md (and optionally annotations.md)
        |
        v
5. Read updated /tmp/wiki.md
   → POST /internal/wiki/versions  [API layer — authenticated with scoped worker token]
     API validates, authorises, inserts new WikiPageVersion, updates current_version_id
        |
        v
6. API triggers embedding of new version → vectors stored in pgvector
        |
        v
7. If annotation threads resolved:
   → POST /internal/wiki/annotations/:id/resolve  [API layer]
        |
        v
8. Clean up /tmp/
```

---

## Postgres Schema

```sql
-- One record per customer wiki
wiki_pages (
  id              uuid primary key,
  customer_id     uuid not null references customers(id),
  current_version_id uuid references wiki_page_versions(id)
)

-- Full version history; each worker run produces one new row
wiki_page_versions (
  id              uuid primary key,
  wiki_page_id    uuid not null references wiki_pages(id),
  content         text not null,               -- markdown
  embedding       vector(768),                 -- nomic-embed-text-v1.5
  created_at      timestamptz not null default now(),
  created_by      uuid,                        -- worker job id or user id
  source          text not null                -- 'autolearn' | 'correction' | 'deepclean'
)

-- Annotation threads anchored to a position in the wiki
wiki_annotations (
  id              uuid primary key,
  wiki_page_id    uuid not null references wiki_pages(id),
  version_id      uuid references wiki_page_versions(id),  -- version when annotation was created
  anchor          text not null,               -- section heading or character offset
  thread          jsonb not null,              -- ordered array of {author, role, body, timestamp}
  status          text not null default 'open' -- 'open' | 'auto_resolved' | 'resolved' | 'dismissed'
)
```

---

## Wiki Mutation Sources

| Trigger                       | Worker type       | Input files                        | Output                                      |
| ----------------------------- | ----------------- | ---------------------------------- | ------------------------------------------- |
| New ground-truth doc ingested | Ingestion worker  | New doc + current wiki             | Updated wiki version                        |
| Gardening cron                | Autolearn worker  | All ground truth + current wiki    | Updated wiki version                        |
| Human opens annotation thread | Correction worker | Current wiki + open annotations    | Updated wiki version + resolved annotations |
| Human triggers deep clean     | Deepclean worker  | All ground truth (no current wiki) | Rebuilt wiki version from scratch           |

---

## Serving to the Website and PWA

The API reads `wiki_page_versions.content` for the current version and returns it
as markdown text. The frontend renders markdown. No transformation layer is needed.

Annotation threads are fetched separately and overlaid on the rendered document at
their anchor positions — the same pattern as Google Docs comments rendered over
document text.

```
GET /api/customers/:id/wiki
→ { content: "# Customer Wiki\n...", version_id: "...", updated_at: "..." }

GET /api/customers/:id/wiki/annotations
→ [{ id, anchor, thread, status }, ...]
```

RLS ensures these endpoints return data only for customers assigned to the
requesting RM. The API layer does not implement additional filtering.

---

## Temp File Lifetime

Temp files written to `/tmp/` inside the worker pod exist only for the duration of
the pod. Because worker pods are ephemeral (they terminate after completing their
job), no ground-truth content persists outside Postgres. There is no intermediate
file store to secure or clean up independently.

---

## Version Retention

All wiki versions are retained in `wiki_page_versions`. No versions are deleted
automatically. The `source` column distinguishes agent-generated revisions from
human-triggered corrections and deep cleans, providing a full audit trail of who
or what changed the wiki and why.

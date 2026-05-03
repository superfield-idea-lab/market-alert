# Rule 6: etl — Extract / Transform / Load

## Summary of the blueprint rule

`etl.yaml` defines a **journaled, progressive-sync ETL pattern** whose governing
invariant is one sentence: _only advance the cursor after data is durably persisted_
(`ETL-P-001` durable-before-advance). Every other rule is a corollary of that single
commitment.

### Core principles

- **Durable-before-advance (`ETL-P-001`).** Cursor commits only after the sink write
  is confirmed. A crash between write and commit produces a safe replay; a crash after
  a premature commit loses data silently — the forbidden failure mode.
- **Monotonic cursor (`ETL-P-002`).** Within a source epoch, the committed cursor never
  moves backward. Backfill and replay are separate operations with their own cursor
  state; they do not reverse the primary cursor.
- **Replay safety (`ETL-P-003`).** Reprocessing the same batch cannot corrupt sink state.
  At-least-once delivery is practical only because idempotent writes make duplicates
  harmless.
- **Stable source identity (`ETL-P-004`).** Source identity (epoch) is tracked separately
  from cursor position. On every run the system validates that the source epoch matches
  the journal; an identity change triggers a reset policy, never a silent resume.
- **Idempotent, append-only sink (`ETL-P-005`).** Raw source payloads are never
  overwritten. Normalized projections may be mutable; the raw layer is immutable.
- **Deterministic ordering (`ETL-P-006`).** "Next after cursor" returns the same items
  on every retry. If the source does not provide natural order, the adapter imposes one.

### Four-component architecture (`ETL-A-001`)

```
┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐
│ Source        │   │ Journal      │   │ Sink                     │
│ Adapter       │   │ Store        │   │                          │
│               │   │              │   │  ┌─────────┐ ┌────────┐ │
│ • identity()  │   │ • load()     │   │  │ raw     │ │ normal │ │
│ • fetch(cur)  │   │ • commit()   │   │  │ store   │ │ store  │ │
│ • ordering    │   │ • history()  │   │  └─────────┘ └────────┘ │
└──────────────┘   └──────────────┘   └──────────────────────────┘
         ▲                  ▲                       ▲
         └──────────── Runner (orchestrator) ───────┘
```

### Synchronization loop (`ETL-A-002`)

1. Load journal state.
2. Read current source identity; if changed, apply reset policy.
3. Fetch next batch after cursor (optionally from `cursor − overlap`).
4. Persist items idempotently to sink.
5. Optionally verify persistence.
6. Commit cursor + run ledger entry.
7. Repeat until source exhausted or budget reached.

Reordering steps 4 and 6 violates durable-before-advance.

### Key design patterns

| Pattern                | Rule      | Purpose                                                   |
| ---------------------- | --------- | --------------------------------------------------------- |
| Journal store          | ETL-D-001 | Durable progress, epoch, run metadata                     |
| Run ledger             | ETL-D-002 | Audit record per run (counts expected vs. persisted)      |
| Batch manifest         | ETL-D-003 | Per-batch item-ID or digest for post-hoc verification     |
| Item lineage           | ETL-D-004 | Every sink record traces to source, epoch, cursor, run    |
| Overlap window         | ETL-D-005 | Re-reads N items before cursor to catch late arrivals     |
| Poison-item quarantine | ETL-D-006 | Malformed item stored raw with errors; pipeline continues |
| Cursor design          | ETL-D-007 | Prefer sequence numbers or composite (timestamp + ID)     |
| Backpressure & budget  | ETL-D-012 | max_items / max_duration / max_bytes per run              |
| Cross-store atomicity  | ETL-D-010 | Journal commit is always the last write                   |

### Prominent threats

- `ETL-T-001` cursor-advanced-before-persist — silent data loss on crash.
- `ETL-T-003` silent-data-loss — errors swallowed without quarantine or halt.
- `ETL-T-004` poison-item-blocks-stream — one bad record stalls every subsequent item.
- `ETL-T-007` cursor-regression — backward cursor causes unbounded rework or corruption.
- `ETL-T-008` unbounded-run — OOM / rate-limit exhaustion from missing budget.

### Antipatterns to avoid

- `ETL-X-001` timestamp as sole cursor (no tie-breaker).
- `ETL-X-002` cursor derived from sink state (`MAX(created_at)`) rather than journal.
- `ETL-X-003` destructive overwrites.
- `ETL-X-005` silent error swallowing.
- `ETL-X-007` unbounded run without budget.

---

## TypeScript implementation specifics

No `etl-ts.yaml` exists. The following maps the generic blueprint onto a TypeScript
implementation, drawing on TS conventions and, where the blueprint overlaps, on patterns
visible in the process-ts and data-ts guidance.

### Module structure

```
packages/core/src/etl/
  journal.ts          — JournalStore interface + PostgreSQL implementation
  runner.ts           — synchronization loop (generic, source-agnostic)
  source-adapter.ts   — SourceAdapter interface
  sink.ts             — Sink interface
  types.ts            — Cursor, Epoch, RunLedgerEntry, ItemLineage, RunBudget
apps/worker/src/
  edgar-ingest-job.ts — EdsarSourceAdapter implements SourceAdapter
```

### TypeScript interfaces

```typescript
// types.ts
export type Cursor = string; // opaque; implementation chooses representation
export type Epoch = string; // opaque source identity

export interface RunBudget {
  maxItems: number;
  maxDurationMs: number;
}

export interface ItemLineage {
  sourceKey: string;
  epoch: Epoch;
  sourceItemId: string;
  cursorAtIngest: Cursor;
  runId: string;
  ingestedAt: Date;
}

// source-adapter.ts
export interface SourceAdapter<T> {
  sourceKey(): string;
  currentEpoch(): Promise<Epoch>;
  fetchAfter(cursor: Cursor, budget: RunBudget): AsyncIterable<T>;
  itemId(item: T): string;
}

// sink.ts
export interface Sink<T> {
  persistIdempotent(items: T[], lineage: ItemLineage[]): Promise<void>;
}

// journal.ts
export interface JournalStore {
  load(sourceKey: string): Promise<{ cursor: Cursor; epoch: Epoch } | null>;
  commit(entry: RunLedgerEntry): Promise<void>;
}
```

### Synchronization loop in TypeScript

```typescript
export async function runSync<T>(
  source: SourceAdapter<T>,
  sink: Sink<T>,
  journal: JournalStore,
  budget: RunBudget,
): Promise<void> {
  const state = await journal.load(source.sourceKey());
  const currentEpoch = await source.currentEpoch();

  if (state && state.epoch !== currentEpoch) {
    await handleEpochReset(source.sourceKey(), currentEpoch, journal);
    return;
  }

  const cursor = state?.cursor ?? INITIAL_CURSOR;
  let committed = cursor;
  let itemsSeen = 0;

  for await (const batch of source.fetchAfter(cursor, budget)) {
    const lineage = batch.map((item) => buildLineage(source, currentEpoch, item));
    await sink.persistIdempotent(batch, lineage); // persist FIRST
    committed = maxCursor(batch.map((item) => source.itemId(item)));
    await journal.commit(buildLedgerEntry(source.sourceKey(), cursor, committed, batch.length));
    itemsSeen += batch.length;
    if (itemsSeen >= budget.maxItems) break; // budget exhausted — clean exit
  }
}
```

The loop never advances `committed` before `sink.persistIdempotent` resolves. The
`journal.commit` call is always the last write, implementing cross-store atomicity
(`ETL-D-010`) without two-phase commit.

### Cursor design for EDGAR RSS

EDGAR ATOM feed entries carry an `<updated>` timestamp and a globally unique
`accession_number` (e.g., `0001234567-26-000001`). Neither alone is a safe cursor:

- Timestamps are not monotonic — SEC backdates amended filings.
- Accession numbers alone are opaque strings; their lexicographic order is not
  guaranteed to match publication order.

The correct cursor is a **composite**: `(updated_timestamp, accession_number)` stored as
a stable string `"2026-04-30T12:34:56Z|0001234567-26-000001"`. Tie-breaking by
accession_number gives deterministic ordering even when two filings share the same
timestamp. This matches `ETL-D-007` cursor-design and avoids `ETL-X-001`.

### PostgreSQL as both sink and journal store

Because the market-alert stack uses PostgreSQL as primary storage, sink and journal can
share a single transaction:

```sql
-- in one transaction: persist raw filing + commit cursor
INSERT INTO corporate_actions (...) VALUES (...) ON CONFLICT (accession_number) DO NOTHING;
INSERT INTO etl_journal (source_key, epoch, cursor, run_id, ...) VALUES (...)
  ON CONFLICT (source_key) DO UPDATE SET cursor = EXCLUDED.cursor, ...;
```

Wrapping both in a single transaction is the strongest guarantee: either both land or
neither does (`ETL-A-002`, `ETL-D-010` note on same-store atomicity). This eliminates
the cross-store crash window entirely.

### Error handling and poison-item quarantine

All item-level errors must produce a visible artifact (`ETL-X-005`). In TypeScript:

```typescript
try {
  await processFiling(item);
} catch (err) {
  await quarantine.store({ raw: item, error: String(err), runId, lineage });
  logger.error({ runId, itemId: source.itemId(item), err }, 'filing quarantined');
  // do NOT rethrow — continue to next item
}
```

The quarantine table mirrors the sink schema but carries an `error_detail` column.
Quarantined items are visible to operators and reprocessable after the bug is fixed.

### Budget enforcement

The runner accepts a `RunBudget` and checks it after each batch commit. When the budget
is exhausted, it returns cleanly (not as an error). The cron scheduler (which produces
`EDGAR_POLL` tasks on a 10-minute cadence) will invoke the worker again, resuming from
the committed cursor.

---

## Application to market-alert PRD/plan

### EDGAR RSS as the sole v1 ingestion source

The plan explicitly establishes EDGAR RSS/ATOM as the only v1 source
(plan §"source-decision: 2026-05-01"). This is an excellent match for the journaled ETL
pattern: the EDGAR ATOM feed is stable, public, and updates every 10 minutes. The plan's
ingestion architecture maps to the four-component ETL model as follows:

| ETL component  | market-alert implementation                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| Source Adapter | `apps/worker/src/edgar-ingest-job.ts` — fetches ATOM feed for each form type       |
| Runner         | `apps/worker/src/runner.ts` — existing `runWorkerLoop` with ETL sync loop embedded |
| Journal Store  | `etl_journal` table in `mkt_app` PostgreSQL pool                                   |
| Sink           | `corporate_actions` table + `raw_filing_store` (append-only raw XML/HTML)          |

### Polling cadence and cursor semantics

The cron producer inserts an `EDGAR_POLL` task every 10 minutes, matching the EDGAR
feed refresh cadence. The idempotency key format is
`edgar_poll:<form_type>:<accession_number>` (plan Phase 2).

The cursor is the **composite (updated_timestamp, accession_number)** described above.
On each poll, the worker fetches entries with `updated > last_cursor_timestamp` OR
`accession_number > last_cursor_accession` to catch late-published entries with earlier
timestamps. The cursor advances to the highest composite value in the batch only after
the `CorporateAction` row is written and confirmed.

### Idempotency

Idempotency is enforced at the database layer by a unique constraint on `accession_number`
in the `corporate_actions` table, with `ON CONFLICT (accession_number) DO NOTHING`.
The run ledger records both `expected_count` and `persisted_count`, enabling detection of
conflicts (already-seen filings return `DO NOTHING` and decrement `persisted_count`).

### Watermarking

The ETL journal (`etl_journal` table) stores:

- `source_key` — `"edgar:<form_type>"` (one journal row per form type)
- `epoch` — a hash of the EDGAR feed's `<generator>` or a static `"edgar_v1"` (EDGAR
  RSS has no UIDVALIDITY equivalent; the epoch value detects feed structural resets)
- `cursor` — composite `(updated_timestamp, accession_number)` as described above
- `run_id` — FK to `etl_run_ledger`

Each form type (`8-K`, `SC 13D`, `S-4`, `425`, `DEF 14A`) has its own journal row and
its own cursor. Per `ETL-D-009` concurrency-partitioning, each can be processed
independently.

### Retry semantics

The task queue (`TQ-D-001`) handles retry scheduling: `claimNextTask` with exponential
backoff (`2^attempt` seconds) up to `max_attempts`. The ETL layer handles item-level
quarantine independently. This maps the blueprint's two-layer retry model: the task queue
retries the run; the ETL runner quarantines individual items within the run.

If the worker is killed mid-run, the task queue's stale-claim recovery reclaims the task.
The next run re-fetches from the committed cursor (safe replay via idempotent sink), not
from mid-batch position. This is the crash-recovery guarantee of `ETL-P-001`.

### Partial-extraction fallback

Per the plan (Phase 3 terms-extraction section), any `DealTerms` field that cannot be
extracted is set to `null` with an `extraction_confidence` flag (`full | partial | failed`).
Alerts with `extraction_confidence: failed` still advance to `Enriched` and are delivered
marked as incomplete — they are never silently dropped or left stuck (`ETL-T-003` mitigated).

The `extraction_confidence` field is the ETL-layer quarantine signal surfaced at the
application level: a "quarantine and continue" policy (`ETL-D-006`) applied to the
enrichment sub-step within the pipeline.

### Out-of-order EDGAR filings

EDGAR may publish amended filings (`8-K/A`) or related forms (`S-4`, `425`) after the
original `8-K`. The plan handles this explicitly (Phase 3 out-of-order section):

- Each EDGAR filing has its own `accession_number` → unique `CorporateAction` row.
- A new filing for an existing `(ticker, event_type)` with an earlier `filed_at`
  re-opens the `ALERT_ENRICH` task if the alert has not yet reached `Delivered`.
- Post-`Delivered` late filings emit an `ALERT_SUPPLEMENT` task.

From the ETL perspective this is an **overlap window** (`ETL-D-005`) applied at the
business logic layer: the enrichment pipeline re-reads earlier-timestamped entities to
catch late-arriving correlated filings. The idempotent sink ensures re-processing is safe.

### Deduplication against prior alerts

The plan's dedup key is `(ticker, event_type, announced_at ± 24h)` (Phase 3 deduplication
section). In ETL terms this is a **cross-item idempotency** check at the application layer,
distinct from the cursor-level idempotency enforced by `accession_number` uniqueness.

The ETL blueprint's requirement that every item end in one of four states (persisted,
quarantined, intentionally skipped, or not yet observed) maps to:

- **Persisted**: new unique corporate action → `CorporateAction` row written.
- **Intentionally skipped**: duplicate accession_number → `ON CONFLICT DO NOTHING`;
  logged in run ledger as `intentional_skip`.
- **Merged (dedup)**: same event from a second source → logged in dedup journal, merged
  into existing `Alert` with multiple `source_references`.
- **Quarantined**: malformed XML, missing required fields → raw XML stored in quarantine
  table with error detail; `ALERT_ENRICH` task still enqueued so the filing is visible.

---

## Recommended technologies and vendors

| Slot                                       | Pick                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RSS/Atom client                            | **`fast-xml-parser` + native `fetch`**                                              | EDGAR ATOM feed is a standard Atom 1.0 document; `fast-xml-parser` (npm, zero dependencies, used by AWS SDK) parses it with strict mode and attribute maps. No dedicated RSS library needed — the feed is simple enough that a 20-line adapter over raw XML is more maintainable than a fat RSS library.                                                                                                                                      |
| HTTP cache strategy                        | **`If-Modified-Since` / `ETag` with in-process memory cache**                       | SEC servers return `Last-Modified` and `ETag` headers on the ATOM feed. The worker stores the last `ETag` in the ETL journal row and sends `If-Modified-Since` on every poll. A `304 Not Modified` response skips the parse step entirely — no items to process, cursor unchanged. No Redis or external cache needed at EDGAR's 10-minute cadence.                                                                                            |
| SEC filing text parser                     | **`cheerio` for HTML, `fast-xml-parser` for XBRL/XML**                              | EDGAR filings are delivered as SGML/HTML (`htm` extension) or XBRL XML. `cheerio` (jQuery-like DOM traversal, zero browser dependency) extracts text from HTML filings for regex-based terms extraction. For XBRL exhibits, `fast-xml-parser` handles structured data. Both are already justified above by the Buy/DIY test.                                                                                                                  |
| Entity extraction (terms from filing text) | **Deterministic regex/rule-based in v1 (no LLM)**                                   | PRD §8 explicitly excludes AI-driven alert generation for v1. The plan confirms rule-based extraction in Phase 3. The `extraction_confidence` flag (`full                                                                                                                                                                                                                                                                                     | partial | failed`) surfaces cases where rules cannot extract a field. LLM-based extraction (Anthropic Claude Sonnet via the Anthropic SDK, with prompt caching on the filing text) is the correct v2 upgrade path once PRD §8's exclusion is lifted — the `extraction_confidence` flag already provides the hook. |
| Watermark store                            | **`etl_journal` table in `mkt_app` PostgreSQL**                                     | Sink and journal share the same PostgreSQL instance → single-transaction commit eliminates cross-store crash window (`ETL-D-010`). Schema: `(source_key TEXT PK, epoch TEXT, cursor TEXT, run_id UUID, updated_at TIMESTAMPTZ)`. History preserved via `etl_run_ledger` table (one row per run).                                                                                                                                              |
| Dead-letter queue                          | **`task_queue` table with `status = 'dead'`**                                       | The plan's existing task queue DLQ (`status = 'dead'`, `DLQ_ALERT_THRESHOLD = 10`) is the correct quarantine mechanism for run-level failures. Item-level quarantine (malformed filings) writes to a dedicated `etl_quarantine` table (`source_key`, `raw_payload BYTEA`, `error_detail TEXT`, `run_id UUID`, `created_at`). DLQ threshold alert already wired in Phase 0.                                                                    |
| Raw event schema                           | **Two-table split: `corporate_actions` (normalized) + `raw_filings` (append-only)** | `corporate_actions` holds the normalized entity with all structured fields and lineage metadata (`source_key`, `epoch`, `cursor_at_ingest`, `run_id`). `raw_filings` holds the original EDGAR XML/HTML bytes (encrypted, `retention_class`) with FK to `corporate_actions.id`. This is the blueprint's raw + normalized projection split (`ETL-P-005`). The raw table is immutable; the normalized table supports upserts on amended filings. |
| Enriched event schema                      | **`alerts` table + `deal_terms` JSONB sub-column**                                  | The `Alert` entity (plan Phase 3) carries `deal_terms JSONB` (structured terms), `extraction_confidence TEXT`, `source_references JSONB[]` (multi-source dedup), and standard lineage fields. JSONB allows partial terms (null fields) without schema changes as the terms model evolves.                                                                                                                                                     |

---

## Gaps and conflicts

**1. No explicit epoch identity for EDGAR RSS.**
EDGAR's ATOM feed has no equivalent of IMAP's `UIDVALIDITY`. The feed URL and content
structure are stable (unchanged since 2006 per the plan's risk table), but if SEC ever
rebuilds the feed with different `accession_number` sequences, the ETL-P-004
stable-source-identity check has no signal to detect it. The mitigation is a hash of the
feed's `<generator>` and `<link rel="self">` as the epoch value; a structural change would
change that hash. This is weaker than IMAP UIDVALIDITY but sufficient for EDGAR's
stability profile.

**2. Cursor stability for amended filings.**
EDGAR amended filings (`8-K/A`) have their own `accession_number` but an `updated`
timestamp that may precede the original `8-K`. The composite cursor
`(updated_timestamp, accession_number)` handles this correctly only if the worker's fetch
window uses a lookback overlap (`ETL-D-005`) to catch late-published entries. The overlap
window size must be tuned: a 24-hour lookback window covers the observed EDGAR amendment
publication lag.

**3. Task queue retry vs. ETL budget exhaustion.**
The task queue retries a failed `EDGAR_POLL` task up to `max_attempts` times. The ETL
budget (`max_items`, `max_duration`) causes a clean exit that is not a failure — the task
queue must treat a budget-exhausted exit as success, not as a failure requiring retry.
The `submitResultViaApi` pattern in `runner.ts` must distinguish `budget_exhausted`
(success, re-schedule) from `error` (failure, retry with backoff). This distinction is
not yet explicit in the plan.

**4. Cross-worker idempotency key collision.**
The plan's idempotency key `edgar_poll:<form_type>:<accession_number>` is correct for
task-queue deduplication. However, the ETL journal uses `source_key = "edgar:<form_type>"`
as one cursor row per form type. If two worker instances claim the same `EDGAR_POLL` task
simultaneously (before the task queue's `FOR UPDATE SKIP LOCKED` prevents it), they would
race on the journal commit. The `FOR UPDATE SKIP LOCKED` claim logic already prevents
this, but the journal commit must also be atomic (`ON CONFLICT DO UPDATE`) to be safe.
This is a latent race that should be documented and tested.

**5. Raw filing encryption vs. ETL replay.**
`ETL-P-005` requires the raw sink to be append-only and replayable. The plan requires
`filing_text` to be field-level encrypted (`DATA-C-023`). Replay requires the decryption
key to still be valid — KMS key rotation (≤ 90 days) must preserve old key versions for
decryption while using the new key for new writes. The plan mentions KMS key rotation but
does not explicitly tie it to ETL replay correctness. Key version must be stored with the
encrypted ciphertext.

---

## Open questions

1. **Overlap window size for amended filings.** What is the observed maximum lag between
   an original EDGAR `8-K` and its amendment (`8-K/A`)? The 24-hour overlap window is a
   guess. If SEC can publish amendments days later, the overlap must be wider — but a
   wider window increases fetch volume on every poll.

2. **Epoch identity signal.** Should the ETL journal's epoch for EDGAR be a hash of the
   feed's structural metadata, or simply a static constant (`"edgar_atom_v1"`) that is
   manually bumped if SEC restructures the feed? A static constant is simpler but requires
   operator action on a feed structural change.

3. **Budget-exhausted vs. error distinction.** The `submitResultViaApi` call in
   `runner.ts` currently takes a single result payload. Does the task queue's result
   schema support a `status: 'budget_exhausted'` outcome that does not increment
   `attempt_count` or trigger retry backoff? If not, a budget-exhausted run will
   unnecessarily count against `max_attempts`.

4. **Reconciliation level for EDGAR.** EDGAR supports re-enumeration: the filing index
   (`https://www.sec.gov/Archives/edgar/full-index/`) provides a daily complete manifest.
   Should the system implement a Level 3 reconciliation (`ETL-D-008`) nightly job that
   cross-references the full-index against landed `corporate_actions` rows? This would
   detect any gaps caused by feed outages. The daily full-index parse is expensive (~MB of
   compressed data per day) but provides the strongest correctness guarantee.

5. **Quarantine reprocessing workflow.** When a malformed EDGAR filing is quarantined, who
   triggers reprocessing after the bug is fixed — an Admin action in the admin panel, an
   automated periodic re-attempt, or a manual database operation? The plan does not specify
   a quarantine drain workflow.

6. **LLM extraction upgrade path.** If PRD §8's AI exclusion is lifted in v2, the entity
   extraction step would switch from regex to an Anthropic Claude API call (recommended:
   `claude-sonnet-4-6` with prompt caching on the static extraction prompt + filing text
   as the cached prefix). The `extraction_confidence` flag is the correct feature boundary.
   Which team owns the v2 extraction schema, and does the `deal_terms JSONB` column need
   a versioned schema from day one to avoid a migration?

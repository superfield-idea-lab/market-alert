# Rule 7: imap-etl — Email-based ETL

## Summary of the blueprint rule

The imap-etl blueprint instantiates the general journaled ETL pattern (rule ETL) over an IMAP
mailbox stream. Its core insight is that IMAP already provides the two primitives the ETL blueprint
requires for correct progressive sync: a **source identity boundary** via `UIDVALIDITY` (a 32-bit
epoch value that changes whenever the UID space is invalidated) and a **stable per-message cursor**
via `UID` (a strictly ascending integer, assigned once, unique within a mailbox epoch).

The blueprint's central invariant:

> For mailbox epoch `(account, mailbox, UIDVALIDITY)`, all messages with `UID <= committed_uid`
> are considered durably imported.

Key structural rules in the blueprint:

- **IMAP-P-001 uid-only-checkpointing** — All durable progress uses UIDs via `UID FETCH` /
  `UID SEARCH`. Sequence numbers are session-relative and must never appear in the journal.
- **IMAP-P-002 uidvalidity-is-epoch** — On every run, read `UIDVALIDITY` from the `SELECT`
  response and compare against the journaled epoch. A change triggers a full epoch rollover
  (`IMAP-D-002`), not a silent cursor reset.
- **IMAP-P-003 raw-landing-is-ingestion-boundary** — A message is ingested when its raw RFC 5322
  bytes are durably stored. MIME parsing, header extraction, and attachment processing are
  downstream operations that never gate landing.
- **IMAP-P-004 epoch-uid-is-item-identity** — The durable item key is `(source_key, UIDVALIDITY,
UID)`. The RFC 5322 `Message-ID` header is a secondary correlation field, not the sync key.
- **IMAP-P-005 arrival-oriented-not-mirror** — v1 is append-only arrival ingestion. Flag changes,
  expunges, and move tracking are deferred to a v2 design built on CONDSTORE/QRESYNC (RFC 7162).
- **IMAP-P-006 idle-assists-polling-not-replaces** — `IMAP IDLE` is a latency optimization.
  The authoritative discovery mechanism is the polling loop; IDLE loss must never stall ingestion.
- **IMAP-P-007 land-before-advance-uid** — The committed UID cursor advances only after raw bytes
  are durably persisted. This is the IMAP instantiation of the ETL foundational invariant
  `durable-before-advance`.

Key design patterns:

- **IMAP-D-001 mailbox-source-adapter** — Maps the general ETL source-adapter interface to IMAP
  commands. Exposes `source_key()`, `open()`, `epoch()`, `enumerate_after(cursor)`, `fetch(uid)`,
  and optionally `stats()`. Sequence numbers do not leak out of the adapter.
- **IMAP-D-003 uid-frontier-cursor** — The cursor is the highest durably landed UID per
  `(account, mailbox, UIDVALIDITY)` tuple.
- **IMAP-D-005 uid-overlap-window** — Each run optionally re-reads `committed_uid - N` UIDs to
  catch messages missed by prior partial failures.
- **IMAP-D-008 range-bounded-enumeration** — Enumeration uses `UID SEARCH UID (cursor+1):(cursor+N)`
  to prevent unbounded SEARCH responses from large backlogs.
- **IMAP-D-009 connection-lifecycle** — On connection drop, discard the in-flight batch and resume
  from the committed cursor after reconnect and UIDVALIDITY re-validation.
- **IMAP-T-007 raw-email-pii-exposure** — Raw email is among the most PII-dense data a system
  can ingest. Application-layer encryption is mandatory when the sink is governed by the DATA blueprint.

The complete sync protocol (`IMAP-A-001`) follows six phases: bootstrap → begin run → epoch
check/rollover → range-bounded enumeration → idempotent raw landing → cursor commit and run
ledger entry. Periodic Layer 3 reconciliation (`IMAP-D-006`) re-enumerates a UID window from
the server to detect gaps not visible from the cursor alone.

## TypeScript implementation specifics

There is no `imap-etl-ts.yaml` blueprint file. The following principles apply when implementing
imap-etl in TypeScript, derived from the general ETL blueprint and standard Node.js ecosystem
conventions.

**IMAP client.** Use `imapflow` (maintained, RFC 9051 compliant, native async iterator API).
It exposes UID-based commands natively and handles TLS, SASL, and `IMAP IDLE` with a wakeup
callback pattern that maps cleanly to the `idle-wakeup-optimization` design pattern.

**Source adapter interface.** Define a TypeScript interface `ImapSourceAdapter` with methods
typed as async:

```typescript
interface ImapSourceAdapter {
  sourceKey(): string;
  epoch(): Promise<number>; // reads UIDVALIDITY from SELECT response
  enumerateAfter(cursor: number, batchSize: number): Promise<number[]>;
  fetchRaw(uid: number): Promise<Buffer>;
  stats(): Promise<{ messages: number; uidNext: number }>;
  close(): Promise<void>;
}
```

The adapter holds the `imapflow` client internally. Sequence numbers never escape the adapter.

**Cursor storage.** Store the cursor as `BIGINT` (or `INTEGER` with unsigned convention) in a
`etl_journal` table with columns: `source_key TEXT`, `uidvalidity BIGINT`, `committed_uid BIGINT`,
`updated_at TIMESTAMPTZ`. Use `INSERT ... ON CONFLICT DO UPDATE` with a `WHERE committed_uid <
EXCLUDED.committed_uid` guard to enforce the monotonic-cursor invariant structurally.

**Idempotent sink.** The raw message table has a `UNIQUE (source_key, uidvalidity, uid)` constraint.
Inserts use `ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE SET ingest_at = EXCLUDED.ingest_at`
(for idempotent replay without data loss).

**PII encryption.** The `raw_bytes` column must be encrypted via AES-256-GCM at the application
layer before the `INSERT`, consistent with `DATA-C-023` and `IMAP-T-007`. Use the KMS-managed
key infrastructure established in Phase 1 of the plan.

**IDLE integration.** Use `imapflow`'s `idle()` method wrapped in a `Promise.race` against a
polling interval timer. Terminate and reissue IDLE every 28 minutes to respect the 29-minute
server timeout (RFC 9051 §6.3.13).

**Run budgets.** The runner loop accepts `{ maxItems, maxDurationMs }`. On budget exhaustion,
commit the cursor and exit cleanly (exit code 0). Budget exhaustion is a normal condition, not
an error — the task queue requeues the next poll via cron.

**Connection drop handling.** Wrap the sync loop in a `try/catch` that on `ImapFlowError`
(or network error): discards the in-flight batch array, calls `client.logout()` / `client.close()`,
reconnects, re-reads UIDVALIDITY, and resumes from the committed cursor. Never resume from
mid-batch UID state stored in a local variable.

## Application to market-alert PRD/plan

### v1 does not use IMAP

The market-alert v1 ingestion source is the **EDGAR RSS/ATOM feed exclusively**. The plan
(Phase 2) explicitly states:

> "EDGAR RSS/ATOM feed is the sole v1 ingestion source; multi-vendor adapter layer deferred to v2."

The `EDGAR_POLL` task triggers the `edgar_ingest` worker, which polls the EDGAR ATOM feed over
HTTPS and parses XML entries. There is no IMAP connection, no mailbox, and no email in v1.
The imap-etl blueprint therefore has **no direct v1 implementation scope**.

### Future application: vendor email alert feeds (post-v1)

The PRD (§1) names commercial vendors — Bloomberg, DealReporter, EventVestors, Bike.ai, LSEG Tora,
VisualPing — as the fragmented detection systems that traders currently rely on. Several of these
vendors distribute alerts over email (proprietary email feeds, SMTP delivery to a designated
mailbox). When these vendor integrations are licensed and activated post-v1, IMAP-based ingestion
becomes the natural adapter pattern:

- A **dedicated service mailbox** (e.g., `alerts@ingest.market-alert.internal`) receives vendor
  email alerts. The imap-etl adapter polls this mailbox and applies the full sync protocol.
- Each vendor occupies a **separate mailbox** (or a separate sub-folder within the same IMAP
  account), giving each an independent `(account, mailbox, UIDVALIDITY)` epoch and an independent
  `committed_uid` cursor. This maps directly to `IMAP-D-010 mailbox-as-partition`.
- The `feature_flags` table already in place (Phase 0, plan §Phase 0) provides per-vendor on/off
  gates — `bloomberg_imap`, `dealreporter_imap`, etc. — without code changes.

### imap-etl patterns that transfer to RSS/EDGAR ingestion

Although v1 uses HTTPS polling of an ATOM feed rather than IMAP, many imap-etl rules have direct
RSS analogues:

| imap-etl rule                                           | EDGAR/RSS analogue                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMAP-P-001` uid-only-checkpointing                     | Cursor is the **last-seen `accession_number`** (plan: `idempotency_key = 'edgar_poll:<form_type>:<accession_number>'`). The accession number is EDGAR's stable, ascending, server-assigned identifier — an exact functional equivalent of a UID within a form-type "mailbox".                                                                      |
| `IMAP-P-002` uidvalidity-is-epoch                       | The EDGAR feed has no explicit epoch signal, but the accession number format embeds a CIK and sequence. If EDGAR resets its numbering (highly unlikely but theoretically possible), the ingestion worker must detect the regression and treat it as an epoch rollover. In practice, the plan's idempotency key scheme already guards against this. |
| `IMAP-P-003` raw-landing-is-ingestion-boundary          | The raw ATOM XML entry (and optionally the raw filing document text) is stored before any enrichment task is enqueued. An `ALERT_ENRICH` task failure must not retroactively block the landing of the raw filing.                                                                                                                                  |
| `IMAP-P-004` epoch-uid-is-item-identity                 | The unique key for a landed filing is `(form_type, accession_number)`. The EDGAR-provided accession number is the authoritative identity, not a derived field like the filer's CIK or filing date.                                                                                                                                                 |
| `IMAP-P-005` arrival-oriented-not-mirror                | The ingestion worker records new filings as they appear. It does not track amendments, withdrawals, or corrections in v1 — those are analogous to "flag changes" and belong in a future enrichment pass.                                                                                                                                           |
| `IMAP-P-006` idle-assists-polling-not-replaces          | EDGAR provides no push/webhook. The `EDGAR_POLL` cron task is the sole discovery mechanism, running every 10 minutes. If EDGAR ever adds a WebSocket or SNS notification (currently unavailable), it should be treated as a latency optimization on top of polling, never a replacement.                                                           |
| `IMAP-P-007` land-before-advance-uid                    | The `accession_number` cursor must not advance until the `CorporateAction` row is committed and the `ALERT_ENRICH` task is enqueued. If the worker crashes after storing the raw filing but before enqueuing the task, the next run re-fetches the same accession number idempotently.                                                             |
| `IMAP-D-005` uid-overlap-window                         | The plan's `edgar_ingest` worker deduplicates via `accession_number`. A configurable overlap of the last N accession numbers re-checked per run is a safe addition and guards against out-of-order EDGAR feed delivery (rare but documented in EDGAR's own guidance).                                                                              |
| `IMAP-D-006` three-layer-audit                          | Level 1: run ledger records claimed accession range. Level 2: item lineage records which accession numbers landed. Level 3: re-query EDGAR full-text search API for a recent time window and compare against the sink. Level 3 is expensive (EDGAR rate-limits the search API) and should run periodically, not on every poll.                     |
| `IMAP-T-003` / `IMAP-X-002` message-id-as-sync-identity | The RSS feed includes `<id>` and `<updated>` elements that could be mistakenly used as the cursor. The correct cursor is `accession_number`, not `<updated>` (which can change on amendments) or `<id>` (which is not guaranteed stable across feed regenerations).                                                                                |
| `IMAP-T-005` / `IMAP-X-003` parse-before-land           | EDGAR XML parsing failures must not prevent storage of the raw feed entry. Land the raw XML first; parse and normalize in the `ALERT_ENRICH` worker.                                                                                                                                                                                               |

## Recommended technologies and vendors

All of the following are **post-v1** recommendations, applicable only when IMAP-based vendor
email feed ingestion is adopted.

| Slot                            | Recommendation                                                                              | Rationale                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IMAP client library**         | `imapflow` (npm)                                                                            | RFC 9051 compliant, maintained by Nodemailer team, native async iterators, UID-first API, built-in IDLE support. Alternative: `node-imap` (older, less RFC 9051 coverage).                                                                                                                                                                        |
| **Service mailbox provider**    | Dedicated Gmail account via **Gmail API** (not raw IMAP)                                    | Gmail's IMAP implementation has known UID stability quirks; the Gmail API provides a `historyId`-based cursor that is more reliable than UIDVALIDITY for this provider. For non-Gmail vendors, raw IMAP over TLS is appropriate. For a self-hosted option, a Dovecot instance controlled by the team gives full UIDVALIDITY stability guarantees. |
| **MIME parser**                 | `mailparser` (npm, from Nodemailer)                                                         | Downstream-only — used after raw landing. Never gates ingestion. Handles MIME multipart, attachments, charsets.                                                                                                                                                                                                                                   |
| **Cross-mailbox deduplication** | PostgreSQL `UNIQUE (source_key, uidvalidity, uid)` with a secondary `message_id_hash` index | Protocol-level deduplication via `(source_key, uidvalidity, uid)` is the primary key. `Message-ID` hash index enables cross-mailbox threading (same vendor alert delivered to two mailboxes) without making it the sync identity.                                                                                                                 |
| **PII encryption**              | Reuse Phase 1 KMS-managed AES-256-GCM key infrastructure                                    | Raw email bytes (IMAP-T-007) are high-PII. Apply the same encrypt-before-insert pattern as alert content and filing text. A separate KMS key class for email payloads is advisable given the sensitivity density.                                                                                                                                 |
| **IMAP connection pool**        | Custom pool using `imapflow` instances, capped per-account                                  | Server limits (typically 10–30 concurrent connections per Gmail account, ~10 for many SMTP/IMAP hosts). Pool size should be a config value, defaulting to 5 to stay well under typical server limits.                                                                                                                                             |

## Gaps and conflicts

1. **No EDGAR epoch signal.** EDGAR's ATOM feed has no `UIDVALIDITY` equivalent. The plan relies
   on the accession number's monotonicity, which is an engineering assumption rather than an RFC
   guarantee. If EDGAR ever resets or reuses accession numbers (e.g., after a major system
   migration), the ingestion worker would silently skip filings. A periodic full-reconciliation
   check against EDGAR's full-text search index (Level 3 audit) is the mitigation, but it is not
   currently specified in the plan.

2. **Gmail API vs. raw IMAP.** If Bloomberg or DealReporter delivers to a Gmail mailbox, raw IMAP
   against Gmail has known caveats: UIDVALIDITY can change after certain server-side operations,
   and Gmail's IMAP behavior deviates from RFC 9051 in documented ways (label-to-folder mapping,
   `\All Mail` UID space). The `imap-etl` blueprint's UIDVALIDITY epoch rollover pattern handles
   this correctly, but the Gmail API's `historyId` cursor is a cleaner fit and avoids the IMAP
   deviation surface entirely. The architecture should not assume raw IMAP works uniformly for all
   cloud mailbox providers.

3. **PII exposure on vendor email.** Vendor email alerts (Bloomberg, DealReporter) embed financial
   deal terms, counterparty names, and sometimes non-public information. `IMAP-T-007` flags raw
   email as high-PII. The Phase 1 KMS infrastructure covers this, but the encryption key class
   for vendor email payloads must be distinct from the key class for EDGAR filing text (which is
   public data). This key-class distinction is not currently specified in the plan.

4. **Vendor email authentication.** Vendor email feeds may require SMTP DKIM verification or
   SPF validation to guard against spoofing. A malicious actor injecting fake "Bloomberg alerts"
   into the service mailbox would bypass the upstream authentication that IMAP alone does not
   provide. The imap-etl blueprint does not address email authentication — it is a domain-specific
   gap that must be resolved at the mailbox ingestion boundary (DKIM/SPF check before landing).

5. **No v1 overlap-window specification.** The plan specifies the `accession_number` idempotency
   key but does not specify an overlap window size for the EDGAR poller. The imap-etl blueprint's
   recommendation of 50 UID overlap (IMAP-D-005) translates to "re-check the last 50 accession
   numbers per form type per run." This is omitted from the plan and should be added as a
   configuration parameter.

6. **IMAP-P-005 arrival-vs-mirror boundary for EDGAR amendments.** EDGAR filings can be amended
   (e.g., `8-K/A` amends an `8-K`). The plan's v1 scope does not specify whether amendments
   trigger a new `CorporateAction` entity or update the existing one. The `arrival-oriented-not-mirror`
   principle suggests treating each accession number (including amendments) as a distinct arrival
   event, but this means the enrichment worker must explicitly detect and correlate amendments
   rather than the ingestion layer doing so.

## Open questions

1. **Overlap window size for EDGAR polling.** Should the `edgar_ingest` worker re-check the last
   N accession numbers per form type on each poll to guard against out-of-order EDGAR delivery?
   If so, what is the default N? The imap-etl blueprint defaults to 50; a smaller value (10–20)
   may be appropriate given that EDGAR's feed is generally well-ordered.

2. **EDGAR amendment handling.** Should `8-K/A` and other amendment form types be ingested as
   independent `CorporateAction` events (arrival-oriented) or merged with the original filing in
   the ingestion layer? The imap-etl pattern favors arrival-oriented (each accession is distinct),
   but the enrichment and deduplication pipeline needs explicit logic to correlate amendments.

3. **Vendor mailbox architecture.** When IMAP-based vendor feeds are adopted post-v1, should each
   vendor use a dedicated service mailbox (cleanest epoch isolation) or sub-folders within a shared
   mailbox (lower operational overhead but shared UIDVALIDITY space)? The imap-etl blueprint
   (`IMAP-D-010`) favors independent mailboxes as partitions.

4. **Gmail API vs. raw IMAP for cloud providers.** If a vendor delivers to a Gmail-hosted mailbox,
   which cursor model should the ingestion adapter use: Gmail API `historyId` or raw IMAP
   UIDVALIDITY? The two models require different adapter implementations and have different
   failure modes.

5. **DKIM/SPF verification.** Should the imap-etl adapter verify DKIM signatures on inbound
   vendor email before landing raw bytes? If a vendor feed is spoofable, injected alerts could
   generate false trade signals. This is a security requirement that needs a decision before any
   IMAP adapter is built.

6. **Key class separation for vendor email vs. public EDGAR data.** EDGAR filing text is public
   information; vendor email alerts may embed non-public or restricted financial data. Should
   the KMS key hierarchy allocate distinct key classes for these two sensitivity levels, or is
   a single "ingested-payload" key class sufficient?

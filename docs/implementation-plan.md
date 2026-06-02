# Ambient AI Research Associate — Implementation Plan

## Goal

Deliver an ambient AI research associate for finance researchers. Given two author-owned
golden documents (Industry Definition and Research Methodology), the system continuously
discovers and scrapes authoritative venues, ingests findings as canonical sources,
synthesizes them into a living cited **wiki** organized per knowledge-bearing entity, and
distills a family of compact **standing prompts**. Incoming catalyst events are routed to
the most specific matching prompt and evaluated in a single fast call, producing
thesis-aware signals that cite back into the wiki. Demo persona: Alice, a small-cap
biotech investor.

This plan supersedes the prior "Market Alert Trading System" plan. The product pivoted
from a raw corporate-action alert pipeline (EDGAR → enrich → dedup → trader UI → trade
lifecycle) to the ambient research-associate model above. The pivot is recorded in
`docs/prd.md` and `docs/architecture.md`; this document decomposes the remaining build-out
into independently shippable tasks.

## Non-goals

- Automated trade execution and broker integrations.
- Multi-tenant team collaboration on a shared wiki (V1 is per-researcher private).
- Mobile application.
- Catalyst classes the demo persona's methodology does not name (general macro,
  generalist news flow) — post-V1.
- Cryptocurrency and commodity asset classes.
- Large-scale historical backtesting (basic replay is in scope).
- Agent-driven edits to the golden Industry Definition or Research Methodology — these
  remain author-only forever.

## Current State

The existing codebase carries a mature substrate from the predecessor Superfield KB
implementation. Reused as-is by the pivot:

- **Platform foundation (done)**: monorepo scaffold, Postgres-native durable task queue,
  feature flags, CI, shared design system.
- **Security foundation (done)**: passkey/WebAuthn auth, ES256 session JWTs with
  revocation, field-level AES-256-GCM encryption, hash-chained audit/journal store,
  per-pool role isolation, rate limiting, key recovery.
- **Knowledge substrate (partially built)**: polymorphic `entities` spine, `relations`,
  `entity_types` registry, `wiki_page_versions`, `corpus_chunks`, and researcher-scoping
  RLS exist. These are the smart-crm-derived primitives the wiki and standing-prompt
  machinery build on.

Product-specific tables and workers for the new model — golden documents and their
author-only enforcement, canonical sources, source findings, confirmed facts with
supersession, wiki debates, standing prompts, market events, signals, and methodology
meta-commentary — are the build-out described below.

Stale platform cleanup (removal of template-derived UI/server features, restoring green
test suites, audit-table CI fixes) is tracked as standalone chores in the Plan, not as
phases here.

## Phases

### Phase 2 — Knowledge substrate and golden documents

Goal: A researcher can author and revise the Industry Definition and Research Methodology
as author-only golden documents, with agents holding read-only access enforced at the API,
RLS, and trigger layers. Unified retrieval returns the active wiki version, latest facts,
and top-k chunks for a subject in one call.

- [ ] Phase 2 dev-scout: golden-document write path end-to-end — researcher authors an
      Industry Definition through the API and reads it back, with a worker token proven
      unable to write it.
- [ ] Golden-document tables and author-only enforcement — `golden_documents` and
      `golden_document_sections`, with layered API + RLS + trigger backstop denying every
      non-researcher write path; violations journalled.
- [ ] Golden-document authoring surface — researcher dashboard to author and revise both
      golden documents, with Authored → Active → Retired revision lifecycle.
- [ ] Unified retrieval module — `fetch(subjectType, subjectId, query?)` returning active
      wiki version, latest non-superseded facts, and top-k embedded corpus chunks.

### Phase 3 — Canonical-source discovery and ingestion

Goal: For a researcher, the system reads the active methodology, registers the venues it
designates as canonical sources, scrapes them on cadence, and turns findings into chunks
and append-only confirmed facts.

- [ ] Phase 3 dev-scout: source-discovery vertical slice — read the active methodology,
      extract the venue catalog, and register one venue as an Active `canonical_source`.
- [ ] Scraper worker — pull each canonical source on its declared cadence, respecting rate
      limits, robots policy, and access mode; persist each payload as a `source_finding`
      with a `content_hash` for dedup.
- [ ] Ingestion and chunking worker — parse each finding into `corpus_chunk` rows with a
      back-link to the finding; quarantine malformed payloads.
- [ ] Fact extraction worker — emit `confirmed_fact` rows attached to subject entities,
      append-only with the `supersedes_fact_id` supersession chain.
- [ ] Researcher-provided uploads — register notes, prior research, and thesis documents
      as canonical sources of subtype `researcher_provided`.

### Phase 4 — Wiki synthesis, citations, and navigation

Goal: Findings and facts materialize into a versioned, cited, navigable wiki. Each rebuild
produces a full-snapshot page version; contested claims surface as debates.

- [ ] Phase 4 dev-scout: wiki-rebuild vertical slice — facts and chunks for one subject
      become a Published `wiki_page_version` with citation edges.
- [ ] Wiki page versioning and crash-resume pipeline — full-snapshot versions through the
      `pending → content_written → embedded → indexed` status pipeline; readers follow
      `currently_published` only at `indexed`.
- [ ] Citation edges — first-class `cites` relations from wiki versions and facts to their
      supporting chunks, facts, and golden-document sections.
- [ ] Wiki debate handling — open a `wiki_debate` when fact-checking does not converge;
      resolve or archive via the debate worker.
- [ ] Wiki navigation UI — researcher can browse, search, and drill into pages per entity,
      with citations visible behind every claim.

### Phase 5 — Standing-prompt distillation and routing

Goal: The system continuously distills the wiki into a family of compact standing prompts
(per-entity default, per-thesis optional, portfolio fallback), kept current and pinnable.

- [ ] Phase 5 dev-scout: distillation vertical slice — a wiki-version publish produces a
      bounded (~100-word) Active `standing_prompt_version` for one entity.
- [ ] Standing-prompt family — per-entity, per-thesis (methodology-declared), and a single
      portfolio fallback, with Draft → Active → Superseded lifecycle.
- [ ] Distillation trigger and debounce — rebuild prompts on wiki-publish events within a
      researcher's scope, collapsing bursts within a debounce window.
- [ ] Pin and override — researcher can pin/unpin any Active prompt and force a redraft;
      pinned prompts block automatic replacement.

### Phase 6 — Catalyst event ingestion and deduplication

Goal: Catalyst events are detected and normalized from filings, wires, and registry diffs;
the same real-world event from multiple venues collapses to one; anticipated windows that
elapse with no disclosure are recorded as silent-passage events.

- [ ] Phase 6 dev-scout: event-ingestion vertical slice — one EDGAR filing lands as a
      normalized `market_event`, queued for evaluation.
- [ ] Event-feed poller — poll filings and trusted wires with `If-Modified-Since`/`ETag`
      caching and a per-feed `land-before-advance` watermark; overlap window for amendments.
- [ ] Cross-venue deduplication — collapse one real-world event arriving via different
      venues using the composite identity (subject entity, event type, anticipated window).
- [ ] Catalyst event state machine — `Expected → Detected → Enriched → Evaluated → Closed`
      with `Disputed` and the terminal `Passed Silently` branch.
- [ ] Silent-passage detection — register anticipated catalysts from the wiki/methodology
      and emit a Passed-Silently event when a window closes with no detected disclosure.

### Phase 7 — Event evaluation and signal routing

Goal: Each event routes to the most specific matching standing prompt and is evaluated in
one fast call into a signal with decomposed confidence; low-confidence signals route to a
Reviewer before delivery.

- [ ] Phase 7 dev-scout: evaluation vertical slice — an event plus the active standing
      prompt produces a `signal` citing the wiki snapshot and prompt revision used.
- [ ] Prompt routing — select the most specific Active prompt (entity → thesis → portfolio
      fallback) for the event's subject.
- [ ] Confidence decomposition — record source trust and extraction certainty as separate
      factors on each signal so the methodology can tune them independently.
- [ ] Signal routing by confidence — direct delivery at or above threshold; below threshold
      routes to the Reviewer queue.
- [ ] Reviewer queue and triage UI — Reviewer (agent default, optional human) approves,
      edits, or suppresses low-confidence signals, with journalled transitions.

### Phase 8 — Signal delivery

Goal: A researcher receives delivered signals in near-real-time on the dashboard and via
outbound channels, scoped to their watchlist.

- [ ] Phase 8 dev-scout: real-time push vertical slice — a Delivered signal reaches the
      researcher dashboard over the LISTEN/NOTIFY → WebSocket path.
- [ ] Signal feed UI — live, sortable, filterable table (by event type, subject entity,
      confidence, date range) with acknowledge / act / dismiss actions.
- [ ] Outbound multi-channel delivery — email, SMS, and webhook channel adapters driven by
      the `SIGNAL_NOTIFY` task type.
- [ ] Watchlist scoping — per-researcher signal scoping derived from the Industry
      Definition watchlist.

### Phase 9 — Researcher feedback and methodology meta-commentary

Goal: The researcher corrects the wiki via chat and inline edits without ever mutating the
golden documents; implied methodology changes accumulate as meta-commentary that is
actively surfaced.

- [ ] Phase 9 dev-scout: chat-feedback vertical slice — a chat correction updates the
      relevant wiki page and, when it implies a methodology shift, opens a meta-commentary
      entry.
- [ ] Inline wiki edit — capture an inline page edit as a one-off correction prompt the
      agent applies and propagates, inserting a superseding fact rather than a destructive
      edit.
- [ ] Methodology meta-commentary entity — agent-writable companion with
      Open → Acknowledged → Folded-In → Archived lifecycle; never writes the golden doc.
- [ ] Meta-commentary surfacing — count badge on the methodology view, weekly digest by
      class, high-urgency escalation, and explicit researcher fold-in action.

### Phase 10 — Admin, cost envelope, and replay

Goal: An Admin governs source scope, scrape limits, retention, and pipeline health; spend
is metered against a per-researcher budget; any past signal is replayable against the exact
inputs that produced it.

- [ ] Phase 10 dev-scout: admin source-scope and health vertical slice — Admin adjusts a
      source's scope and sees pipeline health reflect it.
- [ ] Admin dashboard — source-discovery scope, scrape rate limits, retention policy, DLQ
      replay, and pipeline health views.
- [ ] Cost telemetry and budget enforcement — meter scrape, wiki-rebuild, distillation, and
      per-event evaluation cost against the researcher's monthly envelope; tune cadence to
      stay inside it; surface consumption to researcher and Admin.
- [ ] Replay and audit — replay any past event against the wiki snapshot and
      standing-prompt revision active at the time, with the cited sources and findings.

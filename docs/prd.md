# Product Requirements Document

## 1. Problem Statement

Finance researchers (buy-side analysts, portfolio managers, event-driven traders) lose alpha because the knowledge that informs their decisions — research notes, filings read, prior market context, evolving thesis — lives in fragmented places. When a market event hits, the time required to re-load enough thesis context to act is longer than the arbitrage window allows. Existing market-alert tools fire raw events without thesis context; existing research tools store knowledge but do not evaluate it against incoming events in real time.

This product is an ambient AI memory layer for finance researchers, coupled with a market alert system. Ground truth (filings, notes, prior research, market context) is continuously absorbed and synthesized into a **living wiki** — a navigable, versioned, cited document organized per knowledge-bearing entity (Company/Ticker, Sector, Thesis, Event). The wiki is the persistent, authoritative knowledge substrate the researcher can read, search, and drill into.

From the wiki, the system continuously distills a compact standing prompt (~100 words) representing the researcher's current thesis. When a market event arrives, that standing prompt is evaluated against the event instantly, producing an actionable, thesis-aware trade signal that cites back into the wiki.

V1 narrows the market-event domain to corporate actions (M&A, tender offers, spinoffs, special dividends, rights offerings, bankruptcies, proxy fights).

## 2. Goals and Success Metrics

- **Navigable knowledge substrate**: The researcher can browse, search, and drill into a living wiki of their accumulated knowledge, organized per entity, with citations to ground-truth sources.
- **Thesis-awareness**: Every delivered signal is reasoned against the researcher's current standing prompt, with citations back into the wiki.
- **Instant evaluation**: From event detection to signal delivery, latency stays inside the corporate-action arbitrage window for the researcher's universe.
- **Compact synthesis**: The active standing prompt stays small enough to be evaluated against an event in a single fast model call.
- **Ambient continuity**: New ground truth is absorbed and reflected in the wiki and the standing prompt without requiring explicit researcher action.
- **Recall**: A researcher can trace any delivered signal back to the exact wiki snapshot and standing-prompt revision that produced it.

## 3. User Roles

- **Researcher**: Primary user. Connects sources, reviews and acts on signals, inspects memory and standing prompt, manages watchlists.
- **Reviewer**: Optional intermediary who reviews low-confidence signals before delivery to the researcher.
- **Admin**: Manages source configuration, system health, retention policies, and audit access.

## 4. User Stories

- As a Researcher, I want my notes, filings, and prior context to be absorbed into an ambient memory so that I do not need to manually re-summarize what I know.
- As a Researcher, I want my accumulated knowledge organized as a navigable wiki — one page per company, sector, thesis, and event — so that I can read, search, and drill into what the system knows about any entity.
- As a Researcher, I want every wiki claim to cite the underlying ground truth (filing, note, prior research) so that I can verify the basis before acting.
- As a Researcher, I want the system to maintain a compact standing prompt distilled from the wiki so that incoming events can be evaluated against my thesis instantly.
- As a Researcher, I want to receive trade signals that have been pre-reasoned against my thesis, with citations into the relevant wiki pages, so that I can act without re-deriving context.
- As a Researcher, I want to inspect and override the current standing prompt so that I can correct drift or pin a thesis during a key window.
- As a Researcher, I want to manage watchlists of tickers and corporate-action event types so that only relevant events are evaluated against my thesis.
- As a Reviewer, I want to triage low-confidence signals and approve, edit, or suppress them before they reach the researcher so that signal quality stays high.
- As an Admin, I want to configure upstream sources, monitor pipeline health, and access an audit trail so that I can keep coverage and trust intact.

## 5. Core Workflows

**Happy Path:**

1. Researcher onboards and connects knowledge sources (research notes, filings read, watchlists, prior thesis documents).
2. Ambient ingestion absorbs each new ground-truth item and routes it to the relevant wiki entities (Company/Ticker, Sector, Thesis, Event).
3. The synthesis layer rebuilds the affected wiki pages, producing a new versioned page snapshot with citations back to the source ground truth. The researcher can navigate the wiki at any time — browse pages, follow links between entities, search, and drill into citations.
4. From the current wiki, the synthesis layer continuously distills a compact (~100 word) standing prompt representing the researcher's current thesis. The standing prompt updates automatically, without requiring explicit researcher approval.
5. A corporate-action event is detected and normalized from upstream sources.
6. The event is evaluated against the researcher's active standing prompt in a single fast call, producing a thesis-aware signal: direction, confidence, rationale, and citations into the relevant wiki pages.
7. High-confidence signals are delivered directly to the researcher. Low-confidence signals are routed to a Reviewer queue before delivery.
8. The researcher reviews the signal with its wiki citations, then acknowledges, acts, or dismisses it.
9. The system records the event, the wiki snapshot used, the standing-prompt revision used, and the signal outcome for replay and audit.

**Edge Cases:**

- Conflicting or stale memory items that pull the standing prompt in opposing directions.
- Researcher pins or overrides the standing prompt during a sensitive window; ambient updates pause or queue.
- Multiple competing theses owned by the same researcher (e.g. by sector or strategy).
- Source outage in ambient ingestion; the system continues to evaluate events against the last-known standing prompt and flags the staleness.
- Duplicate events arriving from multiple release mechanisms.
- Event signal evaluation returns ambiguous output; routed to Reviewer.
- Researcher edits or deletes a memory item; downstream standing prompt and prior signals must reflect the provenance change.

## 6. Entity Lifecycle

**Ground-Truth Item**

- States: Ingested → Synthesized → Superseded → Archived.
- Transitions: An ingested item moves to Synthesized once it has been incorporated into one or more wiki pages or marked irrelevant. Superseded when a newer item displaces its contribution. Archived after the retention window or on researcher request.

**Wiki Page**

- One per knowledge-bearing entity. Entity types in V1: Company/Ticker, Sector, Thesis, Event.
- States: Draft → Published → Superseded.
- Transitions: Each rebuild produces a new versioned page snapshot citing the ground-truth items that support its claims. The new snapshot becomes Published and the prior snapshot moves to Superseded. Prior versions remain navigable for audit and replay.

**Standing Prompt**

- States: Draft → Active → Superseded.
- Transitions: The synthesis layer produces a new Draft from the current wiki; the Draft becomes Active automatically, replacing the prior Active prompt, which moves to Superseded. A researcher may pin an Active prompt to block automatic replacement; a researcher may also force a new Draft from the current wiki.

**Market Event** (V1: corporate actions)

- Event types: M&A (announced/rumored), tender offers, spinoffs, special dividends, rights offerings, bankruptcies, proxy fights.
- States: Detected → Enriched → Evaluated → Closed → Disputed.
- Transitions: Auto-advance on enrichment and evaluation; Closed after settlement window; Disputed on legal or regulatory challenge.

**Signal**

- States: Generated → (Reviewing) → Delivered → Acknowledged → Acted | Dismissed → Archived.
- Transitions: High-confidence signals skip Reviewing. Low-confidence signals enter the Reviewer queue and may be approved, edited, or suppressed. The researcher manually transitions Delivered to Acknowledged, then Acted or Dismissed. Archived after retention.

## 7. Integration Needs

- **Real-time corporate-action event feed**: Pluggable adapters for filings and trusted wire sources.
- **Researcher knowledge ingestion**: Capability to absorb the researcher's notes, prior filings read, and thesis documents as ground truth.
- **Semantic ground-truth storage**: A store that supports retrieval and citation across the researcher's accumulated items.
- **Wiki synthesis and navigation**: A capability that materializes ground truth into a versioned, cited, navigable wiki organized per knowledge-bearing entity. The wiki is both human-readable and the upstream substrate for the standing prompt.
- **Standing-prompt distillation and evaluation**: A capability that continuously distills the wiki into a compact standing prompt, and evaluates incoming events against that prompt with citations.
- **Outbound alerting**: Multi-channel signal delivery (email, SMS, webhook).
- **Replay and audit**: Capability to replay any past event against the wiki snapshot and standing-prompt revision that were active at the time.

## 8. Out of Scope

- Automated trade execution and broker integrations.
- Multi-tenant team collaboration on a shared memory (V1 is per-researcher private memory).
- Mobile application.
- Market-event domains beyond corporate actions (earnings, macro, news, etc.) are post-V1.
- Cryptocurrency and commodity asset classes.
- Backtesting historical thesis-prompt performance at scale (basic replay is in scope; large-scale historical sweeps are not).

## 9. Constraints

- **Privacy**: Each researcher's memory and standing prompts are private by default. No cross-researcher leakage.
- **Auditability**: Every delivered signal must reference the exact wiki snapshot and standing-prompt revision used to produce it, and must cite the wiki pages and ground-truth items that supported its rationale. Generative synthesis and evaluation are permitted, but their outputs must remain traceable to their inputs.
- **Wiki as substrate**: The wiki is the authoritative knowledge substrate. The standing prompt is derived from it; signals cite into it. The researcher can always navigate to the wiki page behind any claim.
- **Compact standing prompt**: The active standing prompt is bounded so that evaluation against an event is a single fast call.
- **Latency**: Event-to-signal evaluation must complete inside the arbitrage window for V1 corporate-action event types.
- **Deduplication**: Events must be deduplicated across release mechanisms by a composite key of ticker, event type, and date.
- **Data integrity**: Monetary values use decimal precision; all timestamps are UTC.
- **Regulatory**: Corporate-action disclosure rules apply.

## 10. Open Questions

- What is the target universe size and expected event volume per researcher?
- What ingestion sources must be supported for researcher memory at launch (note apps, document uploads, email, browser capture)?
- What governs how aggressively the standing prompt is rewritten — time-based, change-volume-based, or event-anticipation-based?
- What is the confidence threshold that routes a signal to a Reviewer rather than direct delivery?
- What retention period applies to memory items, standing-prompt revisions, and signals?
- How are competing theses (multiple standing prompts per researcher) selected for evaluation against an incoming event?
- What SLA governs Reviewer triage before an unreviewed low-confidence signal expires?

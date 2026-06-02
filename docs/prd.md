# Product Requirements Document

## 1. Problem Statement

Finance researchers (buy-side analysts, portfolio managers, event-driven traders) each track their own niche industry with their own research methodology. The knowledge that informs their decisions — sources they trust, prior filings, notes, evolving thesis — lives in fragmented places. When a market event hits, the time required to re-load enough thesis context to act is longer than the arbitrage window allows. Existing market-alert tools fire raw events without thesis context; existing research tools store knowledge but do not evaluate it against incoming events in real time.

This product is an **ambient AI research associate** for finance researchers, coupled with a market alert system. The researcher provides two author-owned **golden documents**:

- **Industry Definition** — the sub-industry, niche, and watchlist they care about.
- **Research Methodology** — how they discover, gather, evaluate, weigh, and rank information.

Given these inputs, the ambient AI continuously works on the researcher's behalf: it discovers and scrapes the venues the methodology designates as authoritative, ingests the findings as canonical sources, fact-checks, removes inconsistencies, debates contested claims, and synthesizes everything into a **living wiki** — a navigable, versioned, cited document organized per knowledge-bearing entity (Company/Ticker, Sub-Industry, Thesis, Event, Actor, Canonical Source).

From the wiki, the system continuously distills a **family of compact standing prompts** — one per evaluatable subject — representing the researcher's current thesis at the granularity their methodology demands. Each prompt is bounded (target ~100 words; hard ceiling ~250) so evaluation is a single fast call. The default subject is **per-entity** (one prompt per Company/Ticker on the watchlist); the researcher's methodology may additionally declare **per-thesis** prompts (a named thesis spanning multiple entities) and a coarser **portfolio-level** prompt used only as a fallback when no entity- or thesis-level prompt applies. When a catalyst event arrives, the system routes it to the most specific matching prompt and produces an actionable, thesis-aware signal that cites back into the wiki.

At all times two artifacts are kept current: the **wiki (encyclopedia)** the researcher can read, and the **trade-evaluator prompt family** the system applies to incoming events.

The demo persona for V1 is **Alice, a small-cap biotech investor.** Alice authors her own Industry Definition (a small-cap clinical-stage biotech niche and ticker watchlist) and her own Research Methodology (the venues, source-trust rules, and ranking heuristics she uses). The system acts as Alice's research associate against those golden documents.

V1 covers the catalyst domain the demo persona actually trades: clinical readouts, regulatory actions (approvals, CRLs, AdCom outcomes, clinical holds, designations), safety events, financing and solvency events, M&A and major partnerships, program changes, governance red flags, trading halts near a known catalyst, and silent passage of an anticipated catalyst window. Corporate actions (tender offers, spinoffs, special dividends, rights offerings, bankruptcies, proxy fights) are included as a subset of this domain rather than the whole of it. The catalyst taxonomy is owned by the researcher's Industry Definition; this PRD constrains V1 to _catalyst classes the demo persona's methodology already names_, not to a fixed asset-class-agnostic list.

## 2. Goals and Success Metrics

- **Author-owned methodology**: The researcher's Industry Definition and Research Methodology are golden documents — only the researcher can edit them. Agents read them and act on them, but never modify them.
- **Active research associate**: Given the golden documents, the system autonomously discovers sources, scrapes findings, fact-checks, debates contested claims, and removes inconsistencies — without prompting from the researcher.
- **Navigable knowledge substrate**: The researcher can browse, search, and drill into a living wiki of their accumulated knowledge, organized per entity, with citations to canonical sources.
- **Always-current pair**: At every moment the system maintains a current wiki (encyclopedia) and a current standing prompt (trade evaluator) distilled from it.
- **Thesis-awareness at the right granularity**: Every delivered signal is reasoned against the most specific matching standing prompt (entity → thesis → portfolio fallback), with citations back into the wiki.
- **Instant evaluation against a per-class latency target**: From event detection to signal delivery, latency stays inside an explicit per-catalyst-class target rather than a single global SLA. V1 targets: tape-driven events (trading halts, wire-broken readouts and deals) ≤ 60 seconds; filing-driven events (8-K, registry diffs, regulatory postings) ≤ 5 minutes; silent-passage events evaluated within 15 minutes of the anticipated window closing. The active per-entity prompt is pre-warmed so per-event evaluation is a single call.
- **Methodology evolution without altering golden docs**: When researcher feedback implies a methodology change, the system updates a separate methodology meta-commentary; the researcher's original Research Methodology document is never touched by agents. Meta-commentary is _actively surfaced_ to the researcher on a defined cadence (see §5) so learning does not pile up unread.
- **Coverage growth without altering golden docs**: Agents may _propose_ new candidate venues, sub-segments, or watchlist entries via meta-commentary; the researcher is the sole writer of the golden Industry Definition and Research Methodology.
- **Recall**: A researcher can trace any delivered signal back to the exact wiki snapshot, prompt subject, and prompt revision that produced it.
- **Per-researcher cost envelope**: The system operates within a declared monthly compute budget per researcher; scrape cadence, wiki rebuild frequency, and prompt-distillation frequency are tuned to stay inside it. Budget consumption is visible to the researcher and to the Admin.

## 3. User Roles

- **Researcher**: Primary user (demo persona: Alice, life sciences investor). Sole author of the Industry Definition and Research Methodology golden documents. Reviews and acts on signals, navigates the wiki, gives feedback that the system uses to update the wiki and the methodology meta-commentary.
- **Reviewer**: A triage layer for low-confidence signals. Two variants exist and the researcher chooses one per signal class: a **Reviewer Agent** (default — an LLM-driven reviewer that approves, edits, or suppresses against rules in the methodology) and an **optional human reviewer** (a person, when the researcher wants human-in-the-loop on a class of signals). A solo researcher with no human reviewer defaults entirely to the Reviewer Agent; this requires no extra staffing.
- **Admin**: Manages source-discovery scope, scraping rate limits, system health, retention policies, audit access, and the per-researcher cost envelope.
- **Ambient Agents (system)**: Non-human actors that read the golden documents, discover and scrape canonical sources, ingest and synthesize content, fact-check, debate, and maintain the wiki, the standing prompt, and the methodology meta-commentary. Agents have read-only access to the golden documents and write access to everything else.

## 4. User Stories

- As a Researcher, I want to author an Industry Definition document (sub-industry, niche, watchlist) and have it remain mine — read-only to all agents — so that my scope is preserved exactly as I wrote it.
- As a Researcher, I want to author a Research Methodology document (sources I trust, how I weigh and rank information) and have it remain mine — read-only to all agents — so that the system reasons the way I do.
- As a Researcher, I want the system to act as a research associate: discover the venues my methodology calls authoritative, scrape findings on my behalf, ingest them as canonical sources, and continuously work through them.
- As a Researcher, I want my accumulated knowledge organized as a navigable wiki — one page per company, sub-industry, thesis, event, non-issuer actor, and canonical source — so that I can read, search, and drill into what the system knows about any entity.
- As a Researcher, I want every wiki claim to cite the canonical source that supports it so that I can verify the basis before acting.
- As a Researcher, I want the ambient AI to continuously improve the wiki — fact-check claims, surface and resolve inconsistencies, and debate contested findings — so that the wiki stays trustworthy without my constant attention.
- As a Researcher, I want the system to maintain a compact standing prompt per evaluatable subject (per entity by default, optionally per named thesis, with a portfolio-level fallback) distilled from the current wiki so that incoming events are evaluated against the most specific matching thesis instantly.
- As a Researcher, I want the system to propose candidate new venues, sub-segments, and watchlist entries via meta-commentary so that coverage can grow without anyone editing my golden documents.
- As a Researcher, I want methodology meta-commentary surfaced to me on a regular cadence (digest plus a count badge on the methodology view) so that agent learning does not pile up unread.
- As a Researcher, I want to see the current monthly compute spend against my budget envelope so that I can trade off scrape cadence and rebuild frequency against cost.
- As a Researcher, I want to receive trade signals that have been pre-reasoned against my thesis, with citations into the relevant wiki pages, so that I can act without re-deriving context.
- As a Researcher, I want two ways to give feedback on the wiki — a chat dialogue with an agent, and inline edits inside a wiki page that produce a one-off correction prompt — so that I can correct the system in whichever mode suits the moment.
- As a Researcher, I want my feedback that implies a methodology change recorded as meta-commentary on the methodology, never written back into my original Research Methodology document, so that my golden methodology stays exactly as I wrote it while the system still learns over time.
- As a Researcher, I want to inspect and override the current standing prompt so that I can correct drift or pin a thesis during a key window.
- As a Reviewer (agent or human, per researcher configuration), I want to triage low-confidence signals and approve, edit, or suppress them before they reach the researcher so that signal quality stays high.
- As an Admin, I want to configure source-discovery scope, scraping rate limits, monitor pipeline health, and access an audit trail so that I can keep coverage, trust, and compliance intact.

## 5. Core Workflows

**Happy Path:**

1. Researcher authors the Industry Definition (sub-industry, niche, watchlist) and the Research Methodology (sources, evaluation rules, ranking heuristics) as golden documents.
2. The ambient agents read the golden documents and identify the venues the methodology designates as authoritative.
3. Source-discovery and scraping agents pull findings from those venues on a continuous schedule and register them as canonical sources in the wiki.
4. Ingestion and synthesis agents work through the canonical sources, routing claims to the relevant wiki entities (Company/Ticker, Sub-Industry, Thesis, Event, Actor, Canonical Source).
5. Maintenance agents continuously fact-check claims, surface inconsistencies, debate contested findings, and update or retract wiki claims accordingly. A canonical source may be ingested without changing the wiki if the maintenance pass concludes it adds no new trusted information.
6. Each wiki rebuild produces a new versioned page snapshot citing the canonical sources that support its claims. The researcher can navigate the wiki at any time.
7. From the current wiki, the synthesis layer continuously distills a family of compact standing prompts — one per entity by default, plus any per-thesis prompts the methodology declares, plus a portfolio-level fallback. Each prompt is ~100 words (hard ceiling ~250). Prompts update automatically; the researcher may pin any individual prompt.
8. A catalyst event is detected and normalized from upstream sources, **or** an anticipated event registered on the wiki passes its window with no detected disclosure (silent passage), which is itself recorded as an event.
9. The event is routed to the most specific matching standing prompt (entity → thesis → portfolio fallback) and evaluated in a single fast call, producing a thesis-aware signal: direction, confidence, rationale, the prompt subject and revision used, and citations into the relevant wiki pages.
10. High-confidence signals are delivered directly to the researcher. Low-confidence signals are routed to a Reviewer queue (Reviewer Agent by default, optional human reviewer per signal class) before delivery.
11. The researcher reviews the signal with its wiki citations, then acknowledges, acts, or dismisses it.
12. The system records the event, the wiki snapshot used, the standing-prompt revision used, and the signal outcome for replay and audit.

**Researcher Feedback Loop:**

- **Chat dialogue**: The researcher opens a conversation with an agent and describes the change they want (e.g. "Company X's pipeline page is overweighting press releases; treat the regulatory filing as primary"). The agent applies the change to the relevant wiki pages and, if the feedback implies a methodology shift, records it in the methodology meta-commentary.
- **Inline edit**: Inside a wiki page, the researcher edits text directly. The system captures the diff as a one-off correction prompt for the agent, which applies the correction and propagates implications. If the correction implies a methodology shift, it is recorded in the methodology meta-commentary.
- In neither path does any agent modify the researcher's original Industry Definition or Research Methodology golden documents.

**Meta-Commentary Surfacing Loop:**

- Each open meta-commentary entry carries a class (proposed venue, proposed sub-segment, proposed watchlist change, methodology drift observation, demoted source) and an urgency tier.
- A count badge on the methodology view reflects the number of open entries.
- A weekly digest summarizes new entries by class, with one-click acknowledge or fold-in actions. High-urgency entries (e.g. a Tier A source has been retracted by its publisher) escalate to immediate notification rather than waiting for the digest.
- Folding an entry into the golden Methodology is an explicit researcher action; nothing is ever auto-applied.

**Edge Cases:**

- Conflicting canonical sources that pull the standing prompt in opposing directions; surfaced as a debate annotation on the wiki.
- Researcher pins or overrides the standing prompt during a sensitive window; ambient updates pause or queue.
- Multiple competing theses owned by the same researcher (e.g. by sub-niche).
- Scraping is blocked, rate-limited, or returns empty at a designated source; the system flags coverage degradation and continues with the last-known wiki and evaluator.
- Researcher feedback contradicts the current Research Methodology; the contradiction is recorded in the methodology meta-commentary and surfaced to the researcher (who alone can choose whether to update the golden doc).
- Duplicate events arriving from multiple release mechanisms.
- Event evaluation returns ambiguous output; routed to Reviewer.
- A canonical source is retracted by its publisher; downstream wiki claims and prior signals must reflect the provenance change.

## 6. Entity Lifecycle

**Industry Definition** (golden document)

- Author: Researcher only. Agents read; agents never write.
- States: Authored → Active → Retired (when researcher replaces it).
- Transitions: Researcher edits produce a new Active revision; prior revision is Retired. No agent transition is permitted.

**Research Methodology** (golden document)

- Author: Researcher only. Agents read; agents never write.
- States: Authored → Active → Retired (when researcher replaces it).
- Transitions: Same as Industry Definition. Methodology meta-commentary is a separate entity (below) and does not modify this document.

**Methodology Meta-Commentary**

- Agent-writable companion to the Research Methodology. Records observations, drift notes, and implied changes derived from researcher feedback and from maintenance findings.
- States: Open → Acknowledged → Folded-In (when the researcher chooses to update their golden doc) → Archived.
- Transitions: System opens a meta-commentary entry whenever feedback or maintenance implies a methodology shift. Researcher acknowledges entries. If the researcher updates the golden Methodology to reflect a meta entry, that entry is marked Folded-In. Entries are never auto-applied to the golden doc.

**Canonical Source**

- Discovered or registered as authoritative per the Research Methodology. Examples: a specific regulatory filing index, a specific publication, a specific dataset.
- States: Discovered → Active → Retracted → Archived.
- Transitions: A source enters Active once scraping has confirmed access and trust per the methodology. Retracted when the publisher retracts content or the methodology demotes the venue. Archived after retention.

**Source Finding** (a scraped or researcher-provided item attached to a Canonical Source)

- States: Scraped → Ingested → Synthesized → Superseded → Archived.
- Transitions: A scraped finding becomes Ingested once parsed. Synthesized once incorporated into one or more wiki pages (or explicitly judged non-additive by the maintenance pass). Superseded when a newer finding displaces its contribution. Archived after retention.

**Wiki Page**

- One per knowledge-bearing entity. Entity types in V1: Company/Ticker, Sub-Industry, Thesis, Event, Actor (non-issuer counterparties such as regulators, payers, monitoring committees, dominant counterparties), Canonical Source.
- States: Draft → Published → Superseded.
- Transitions: Each rebuild produces a new versioned page snapshot citing the canonical sources and source findings that support its claims. The new snapshot becomes Published and the prior snapshot moves to Superseded. Prior versions remain navigable for audit and replay.

**Wiki Debate**

- An open question or contested claim attached to a wiki page when fact-checking or debate among ambient agents has not converged.
- States: Open → Resolved → Archived.
- Transitions: Open while contradictory evidence persists; Resolved when sufficient evidence (or researcher feedback) settles the question; Archived after retention.

**Standing Prompt**

- Subject types: Entity (one per watchlist Company/Ticker — default), Thesis (a named multi-entity thesis declared by the methodology), Portfolio (a single coarse fallback).
- Bounded length: target ~100 words, hard ceiling ~250 words.
- States: Draft → Active → Superseded; orthogonally Pinned (researcher-locked, blocks automatic replacement).
- Transitions: The synthesis layer produces a new Draft per subject from the current wiki; the Draft becomes Active automatically, replacing the prior Active prompt for that subject, which moves to Superseded. A researcher may pin or unpin any Active prompt and may force a new Draft for any subject. When evaluating an event, routing prefers the most specific Active prompt that matches the event's subject entity or thesis; the Portfolio prompt is used only when no entity or thesis prompt applies.

**Catalyst Event** (V1 scope follows the demo persona's catalyst taxonomy)

- Event classes: clinical readout (efficacy), regulatory action (approval, CRL, AdCom outcome, clinical hold, designation), safety event, financing / solvency event, M&A or major partnership, program change / pipeline discontinuation, governance red flag, trading halt near a known catalyst, silent passage of an anticipated catalyst window, and corporate actions (tender offers, spinoffs, special dividends, rights offerings, bankruptcies, proxy fights) where the methodology calls them out.
- States: Expected → Detected → Enriched → Evaluated → Closed → Disputed. A parallel terminal state, **Passed Silently**, captures Expected events whose anticipated window elapses with no detected disclosure — silent passage is itself an event that the trade evaluator may act on.
- Transitions: An Expected event is created when the wiki or methodology designates an anticipated catalyst (window or date). On disclosure it transitions Expected → Detected → Enriched → Evaluated → Closed. If the anticipated window closes with no detected disclosure, the event transitions Expected → Passed Silently and is evaluated against the standing prompt the same way. Disputed on legal or regulatory challenge.

**Signal**

- States: Generated → (Reviewing) → Delivered → Acknowledged → Acted | Dismissed → Archived.
- Transitions: High-confidence signals skip Reviewing. Low-confidence signals enter the Reviewer queue and may be approved, edited, or suppressed. The researcher manually transitions Delivered to Acknowledged, then Acted or Dismissed. Archived after retention.

## 7. Integration Needs

- **Real-time catalyst event feeds**: Pluggable adapters covering filings (SEC EDGAR), press-release wires, regulatory sources (e.g. FDA, EMA), and registry diffs (e.g. clinicaltrials.gov), scoped to the catalyst classes the methodology names.
- **Golden-document authoring surface**: A capability for the researcher to author and revise the Industry Definition and Research Methodology, with a strict guarantee that agents have read-only access to these documents.
- **Source discovery and scraping**: A capability to discover the venues the methodology designates as authoritative and to scrape their content on a continuous schedule, respecting venue rate limits and access rules.
- **Canonical-source registry and ingestion**: Capability to register canonical sources — both scraped venues (per the methodology) and researcher-provided uploads (notes, prior research, thesis documents) — and ingest their findings.
- **Wiki synthesis, fact-checking, and debate**: A capability that materializes findings into a versioned, cited, navigable wiki organized per knowledge-bearing entity, continuously fact-checks claims, reconciles inconsistencies, and surfaces debates when convergence fails.
- **Standing-prompt distillation, routing, and evaluation**: A capability that continuously distills the wiki into a family of compact standing prompts (per-entity, per-thesis, portfolio fallback), routes each incoming event to the most specific matching prompt, and applies that prompt to the event with citations.
- **Cost telemetry and budget enforcement**: A capability that meters scrape volume, wiki rebuild cost, prompt distillation cost, and per-event evaluation cost against the researcher's monthly envelope, and that the Admin can tune.
- **Researcher feedback surface**: A capability for the researcher to give feedback via chat dialogue with an agent and via inline edits inside wiki pages. Feedback that implies a methodology change is recorded in the methodology meta-commentary, never written back to the golden Methodology document.
- **Outbound alerting**: Multi-channel signal delivery (email, SMS, webhook).
- **Replay and audit**: Capability to replay any past event against the wiki snapshot and standing-prompt revision that were active at the time, and to inspect the canonical sources and findings cited.

## 8. Out of Scope

- Automated trade execution and broker integrations.
- Multi-tenant team collaboration on a shared wiki (V1 is per-researcher private wiki).
- Mobile application.
- Catalyst classes not named by the demo persona's methodology (general macro, earnings beats/misses unrelated to the niche, generalist news flow) are post-V1.
- Cryptocurrency and commodity asset classes.
- Backtesting historical thesis-prompt performance at scale (basic replay is in scope; large-scale historical sweeps are not).
- Agent-driven edits to the researcher's golden Industry Definition or Research Methodology documents — these remain author-only forever, not only in V1.
- Scraping venues that the researcher's methodology has not designated as authoritative.

## 9. Constraints

- **Golden-document invariant**: The researcher's Industry Definition and Research Methodology are author-only. No agent — orchestrator, scraper, synthesizer, fact-checker, debater, or feedback handler — may write to these documents. All system learning about methodology drift accumulates in the methodology meta-commentary instead.
- **Privacy**: Each researcher's wiki, golden documents, and standing prompts are private by default. No cross-researcher leakage.
- **Auditability**: Every delivered signal must reference the exact wiki snapshot and standing-prompt revision used to produce it, and must cite the wiki pages and ground-truth items that supported its rationale. Generative synthesis and evaluation are permitted, but their outputs must remain traceable to their inputs.
- **Wiki as substrate**: The wiki is the authoritative knowledge substrate. The standing prompt is derived from it; signals cite into it. The researcher can always navigate to the wiki page behind any claim.
- **Compact standing prompts**: Each active standing prompt is bounded (target ~100 words, hard ceiling ~250) so that evaluation against an event is a single fast call.
- **Latency targets per catalyst class**: Tape-driven events (trading halts, wire-broken readouts and deals) ≤ 60s detection-to-signal; filing-driven events ≤ 5min; silent-passage events evaluated within 15min of the anticipated window closing. Prompts are pre-warmed per entity so the routing step does not add cold-start latency.
- **Per-researcher cost envelope**: Continuous scrape, wiki rebuild, and prompt distillation operate inside a declared monthly compute budget; the Admin tunes cadence to stay within it and the researcher sees consumption against budget.
- **Cross-venue deduplication**: A single real-world event arriving via different venues (for example a press-release wire and a subsequent regulatory filing days later) must collapse to one event. Deduplication uses a composite identity (subject entity, event type, anticipated date window) and tolerates lag between the leading and lagging venue.
- **Entity-relative materiality**: Signal scoring is relative to the subject entity, not absolute. A given financing, deal, or readout is interpreted against the entity's current wiki context (size, runway, prior catalysts) rather than against a fixed magnitude threshold.
- **Confidence decomposition**: A signal's confidence is the product of two factors — source trust (the tier of the supporting wiki claims, per the researcher's methodology) and extraction certainty (how unambiguously the event maps to the standing prompt). Both factors are recorded so the researcher's methodology can tune them independently.
- **Idempotent replay**: Re-processing the same source inputs over the same time window must produce no duplicate canonical sources, source findings, wiki claims, or signals.
- **Data integrity**: Monetary values use decimal precision; all timestamps are UTC.
- **Regulatory**: Corporate-action disclosure rules apply.

## 10. Open Questions

- What is the target universe size and expected event volume per researcher?
- What format are the golden documents authored in, and how does the researcher revise them in flight without disrupting active synthesis?
- (Resolved) The system may propose new venues, sub-segments, and watchlist entries via meta-commentary; the researcher remains sole writer of the golden documents.
- What scraping cadence, rate limits, and access modes are acceptable per venue category?
- What governs how aggressively the standing prompt is rewritten — time-based, change-volume-based, or event-anticipation-based?
- How are wiki debates surfaced to the researcher (badge on page, queue, digest)?
- What is the confidence threshold that routes a signal to a Reviewer rather than direct delivery?
- What retention period applies to canonical sources, findings, wiki revisions, standing-prompt revisions, and signals?
- (Resolved) Events route to the most specific matching prompt: Entity (default) → Thesis (when the methodology declares one that covers the entity) → Portfolio (fallback). Open: when multiple Thesis prompts match, are they evaluated in parallel and reconciled, or does the methodology declare priority?
- What SLA governs Reviewer triage before an unreviewed low-confidence signal expires?

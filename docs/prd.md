# Product Requirements Document

## 1. Problem Statement

Finance researchers (buy-side analysts, portfolio managers, event-driven traders) each track their own niche industry with their own research methodology. The knowledge that informs their decisions — sources they trust, prior filings, notes, evolving thesis — lives in fragmented places. When a market event hits, the time required to re-load enough thesis context to act is longer than the arbitrage window allows. Existing market-alert tools fire raw events without thesis context; existing research tools store knowledge but do not evaluate it against incoming events in real time.

This product is an **ambient AI research associate** for finance researchers, coupled with a market alert system. The researcher provides two author-owned **golden documents**:

- **Industry Definition** — the sub-industry, niche, and watchlist they care about.
- **Research Methodology** — how they discover, gather, evaluate, weigh, and rank information.

Given these inputs, the ambient AI continuously works on the researcher's behalf: it discovers and scrapes the venues the methodology designates as authoritative, ingests the findings as canonical sources, fact-checks, removes inconsistencies, debates contested claims, and synthesizes everything into a **living wiki** — a navigable, versioned, cited document organized per knowledge-bearing entity (Company/Ticker, Sub-Industry, Thesis, Event, Canonical Source).

From the wiki, the system continuously distills a compact **standing prompt (~100 words)** — the trade evaluator — representing the researcher's current thesis. When a market event arrives, that evaluator is applied to the event instantly, producing an actionable, thesis-aware trade signal that cites back into the wiki.

At all times two artifacts are kept current: the **wiki (encyclopedia)** the researcher can read, and the **trade evaluator (standing prompt)** the system applies to incoming events.

The demo persona for V1 is **Tom, a life sciences investor.** Tom authors his own Industry Definition (a life-sciences sub-niche and ticker watchlist) and his own Research Methodology (the venues, source-trust rules, and ranking heuristics he uses). The system acts as Tom's research associate against those golden documents.

V1 narrows the market-event domain to corporate actions (M&A, tender offers, spinoffs, special dividends, rights offerings, bankruptcies, proxy fights).

## 2. Goals and Success Metrics

- **Author-owned methodology**: The researcher's Industry Definition and Research Methodology are golden documents — only the researcher can edit them. Agents read them and act on them, but never modify them.
- **Active research associate**: Given the golden documents, the system autonomously discovers sources, scrapes findings, fact-checks, debates contested claims, and removes inconsistencies — without prompting from the researcher.
- **Navigable knowledge substrate**: The researcher can browse, search, and drill into a living wiki of their accumulated knowledge, organized per entity, with citations to canonical sources.
- **Always-current pair**: At every moment the system maintains a current wiki (encyclopedia) and a current standing prompt (trade evaluator) distilled from it.
- **Thesis-awareness**: Every delivered signal is reasoned against the researcher's current standing prompt, with citations back into the wiki.
- **Instant evaluation**: From event detection to signal delivery, latency stays inside the corporate-action arbitrage window for the researcher's universe.
- **Methodology evolution without altering golden docs**: When researcher feedback implies a methodology change, the system updates a separate methodology meta-commentary; the researcher's original Research Methodology document is never touched by agents.
- **Recall**: A researcher can trace any delivered signal back to the exact wiki snapshot and standing-prompt revision that produced it.

## 3. User Roles

- **Researcher**: Primary user (demo persona: Tom, life sciences investor). Sole author of the Industry Definition and Research Methodology golden documents. Reviews and acts on signals, navigates the wiki, gives feedback that the system uses to update the wiki and the methodology meta-commentary.
- **Reviewer**: Optional intermediary who reviews low-confidence signals before delivery to the researcher.
- **Admin**: Manages source-discovery scope, scraping rate limits, system health, retention policies, and audit access.
- **Ambient Agents (system)**: Non-human actors that read the golden documents, discover and scrape canonical sources, ingest and synthesize content, fact-check, debate, and maintain the wiki, the standing prompt, and the methodology meta-commentary. Agents have read-only access to the golden documents and write access to everything else.

## 4. User Stories

- As a Researcher, I want to author an Industry Definition document (sub-industry, niche, watchlist) and have it remain mine — read-only to all agents — so that my scope is preserved exactly as I wrote it.
- As a Researcher, I want to author a Research Methodology document (sources I trust, how I weigh and rank information) and have it remain mine — read-only to all agents — so that the system reasons the way I do.
- As a Researcher, I want the system to act as a research associate: discover the venues my methodology calls authoritative, scrape findings on my behalf, ingest them as canonical sources, and continuously work through them.
- As a Researcher, I want my accumulated knowledge organized as a navigable wiki — one page per company, sub-industry, thesis, event, and canonical source — so that I can read, search, and drill into what the system knows about any entity.
- As a Researcher, I want every wiki claim to cite the canonical source that supports it so that I can verify the basis before acting.
- As a Researcher, I want the ambient AI to continuously improve the wiki — fact-check claims, surface and resolve inconsistencies, and debate contested findings — so that the wiki stays trustworthy without my constant attention.
- As a Researcher, I want the system to maintain a compact standing prompt (trade evaluator) distilled from the current wiki so that incoming events can be evaluated against my thesis instantly.
- As a Researcher, I want to receive trade signals that have been pre-reasoned against my thesis, with citations into the relevant wiki pages, so that I can act without re-deriving context.
- As a Researcher, I want two ways to give feedback on the wiki — a chat dialogue with an agent, and inline edits inside a wiki page that produce a one-off correction prompt — so that I can correct the system in whichever mode suits the moment.
- As a Researcher, I want my feedback that implies a methodology change recorded as meta-commentary on the methodology, never written back into my original Research Methodology document, so that my golden methodology stays exactly as I wrote it while the system still learns over time.
- As a Researcher, I want to inspect and override the current standing prompt so that I can correct drift or pin a thesis during a key window.
- As a Reviewer, I want to triage low-confidence signals and approve, edit, or suppress them before they reach the researcher so that signal quality stays high.
- As an Admin, I want to configure source-discovery scope, scraping rate limits, monitor pipeline health, and access an audit trail so that I can keep coverage, trust, and compliance intact.

## 5. Core Workflows

**Happy Path:**

1. Researcher authors the Industry Definition (sub-industry, niche, watchlist) and the Research Methodology (sources, evaluation rules, ranking heuristics) as golden documents.
2. The ambient agents read the golden documents and identify the venues the methodology designates as authoritative.
3. Source-discovery and scraping agents pull findings from those venues on a continuous schedule and register them as canonical sources in the wiki.
4. Ingestion and synthesis agents work through the canonical sources, routing claims to the relevant wiki entities (Company/Ticker, Sub-Industry, Thesis, Event, Canonical Source).
5. Maintenance agents continuously fact-check claims, surface inconsistencies, debate contested findings, and update or retract wiki claims accordingly. A canonical source may be ingested without changing the wiki if the maintenance pass concludes it adds no new trusted information.
6. Each wiki rebuild produces a new versioned page snapshot citing the canonical sources that support its claims. The researcher can navigate the wiki at any time.
7. From the current wiki, the synthesis layer continuously distills a compact (~100 word) standing prompt (the trade evaluator). The evaluator updates automatically, without requiring researcher approval.
8. A corporate-action event is detected and normalized from upstream sources, **or** an anticipated event registered on the wiki passes its window with no detected disclosure (silent passage), which is itself recorded as an event.
9. The trade evaluator is applied to the event in a single fast call, producing a thesis-aware signal: direction, confidence, rationale, and citations into the relevant wiki pages.
10. High-confidence signals are delivered directly to the researcher. Low-confidence signals are routed to a Reviewer queue before delivery.
11. The researcher reviews the signal with its wiki citations, then acknowledges, acts, or dismisses it.
12. The system records the event, the wiki snapshot used, the standing-prompt revision used, and the signal outcome for replay and audit.

**Researcher Feedback Loop:**

- **Chat dialogue**: The researcher opens a conversation with an agent and describes the change they want (e.g. "Company X's pipeline page is overweighting press releases; treat the regulatory filing as primary"). The agent applies the change to the relevant wiki pages and, if the feedback implies a methodology shift, records it in the methodology meta-commentary.
- **Inline edit**: Inside a wiki page, the researcher edits text directly. The system captures the diff as a one-off correction prompt for the agent, which applies the correction and propagates implications. If the correction implies a methodology shift, it is recorded in the methodology meta-commentary.
- In neither path does any agent modify the researcher's original Industry Definition or Research Methodology golden documents.

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

**Source Finding** (a scraped item from a Canonical Source)

- States: Scraped → Ingested → Synthesized → Superseded → Archived.
- Transitions: A scraped finding becomes Ingested once parsed. Synthesized once incorporated into one or more wiki pages (or explicitly judged non-additive by the maintenance pass). Superseded when a newer finding displaces its contribution. Archived after retention.

**Wiki Page**

- One per knowledge-bearing entity. Entity types in V1: Company/Ticker, Sub-Industry, Thesis, Event, Canonical Source.
- States: Draft → Published → Superseded.
- Transitions: Each rebuild produces a new versioned page snapshot citing the canonical sources and source findings that support its claims. The new snapshot becomes Published and the prior snapshot moves to Superseded. Prior versions remain navigable for audit and replay.

**Wiki Debate**

- An open question or contested claim attached to a wiki page when fact-checking or debate among ambient agents has not converged.
- States: Open → Resolved → Archived.
- Transitions: Open while contradictory evidence persists; Resolved when sufficient evidence (or researcher feedback) settles the question; Archived after retention.

**Standing Prompt**

- States: Draft → Active → Superseded.
- Transitions: The synthesis layer produces a new Draft from the current wiki; the Draft becomes Active automatically, replacing the prior Active prompt, which moves to Superseded. A researcher may pin an Active prompt to block automatic replacement; a researcher may also force a new Draft from the current wiki.

**Market Event** (V1: corporate actions)

- Event types: M&A (announced/rumored), tender offers, spinoffs, special dividends, rights offerings, bankruptcies, proxy fights.
- States: Expected → Detected → Enriched → Evaluated → Closed → Disputed. A parallel terminal state, **Passed Silently**, captures Expected events whose anticipated window elapses with no detected disclosure — silent passage is itself an event that the trade evaluator may act on.
- Transitions: An Expected event is created when the wiki or methodology designates an anticipated catalyst (window or date). On disclosure it transitions Expected → Detected → Enriched → Evaluated → Closed. If the anticipated window closes with no detected disclosure, the event transitions Expected → Passed Silently and is evaluated against the standing prompt the same way. Disputed on legal or regulatory challenge.

**Signal**

- States: Generated → (Reviewing) → Delivered → Acknowledged → Acted | Dismissed → Archived.
- Transitions: High-confidence signals skip Reviewing. Low-confidence signals enter the Reviewer queue and may be approved, edited, or suppressed. The researcher manually transitions Delivered to Acknowledged, then Acted or Dismissed. Archived after retention.

## 7. Integration Needs

- **Real-time corporate-action event feed**: Pluggable adapters for filings and trusted wire sources.
- **Golden-document authoring surface**: A capability for the researcher to author and revise the Industry Definition and Research Methodology, with a strict guarantee that agents have read-only access to these documents.
- **Source discovery and scraping**: A capability to discover the venues the methodology designates as authoritative and to scrape their content on a continuous schedule, respecting venue rate limits and access rules.
- **Canonical-source registry and ingestion**: Capability to register scraped venues as canonical sources and ingest their findings.
- **Wiki synthesis, fact-checking, and debate**: A capability that materializes findings into a versioned, cited, navigable wiki organized per knowledge-bearing entity, continuously fact-checks claims, reconciles inconsistencies, and surfaces debates when convergence fails.
- **Standing-prompt distillation and evaluation**: A capability that continuously distills the wiki into a compact standing prompt (the trade evaluator), and applies that evaluator to incoming events with citations.
- **Researcher feedback surface**: A capability for the researcher to give feedback via chat dialogue with an agent and via inline edits inside wiki pages. Feedback that implies a methodology change is recorded in the methodology meta-commentary, never written back to the golden Methodology document.
- **Outbound alerting**: Multi-channel signal delivery (email, SMS, webhook).
- **Replay and audit**: Capability to replay any past event against the wiki snapshot and standing-prompt revision that were active at the time, and to inspect the canonical sources and findings cited.

## 8. Out of Scope

- Automated trade execution and broker integrations.
- Multi-tenant team collaboration on a shared wiki (V1 is per-researcher private wiki).
- Mobile application.
- Market-event domains beyond corporate actions (earnings, macro, news, etc.) are post-V1.
- Cryptocurrency and commodity asset classes.
- Backtesting historical thesis-prompt performance at scale (basic replay is in scope; large-scale historical sweeps are not).
- Agent-driven edits to the researcher's golden Industry Definition or Research Methodology documents — these remain author-only forever, not only in V1.
- Scraping venues that the researcher's methodology has not designated as authoritative.

## 9. Constraints

- **Golden-document invariant**: The researcher's Industry Definition and Research Methodology are author-only. No agent — orchestrator, scraper, synthesizer, fact-checker, debater, or feedback handler — may write to these documents. All system learning about methodology drift accumulates in the methodology meta-commentary instead.
- **Privacy**: Each researcher's wiki, golden documents, and standing prompts are private by default. No cross-researcher leakage.
- **Auditability**: Every delivered signal must reference the exact wiki snapshot and standing-prompt revision used to produce it, and must cite the wiki pages and ground-truth items that supported its rationale. Generative synthesis and evaluation are permitted, but their outputs must remain traceable to their inputs.
- **Wiki as substrate**: The wiki is the authoritative knowledge substrate. The standing prompt is derived from it; signals cite into it. The researcher can always navigate to the wiki page behind any claim.
- **Compact standing prompt**: The active standing prompt is bounded so that evaluation against an event is a single fast call.
- **Latency**: Event-to-signal evaluation must complete inside the arbitrage window for V1 corporate-action event types.
- **Cross-venue deduplication**: A single real-world event arriving via different venues (for example a press-release wire and a subsequent regulatory filing days later) must collapse to one event. Deduplication uses a composite identity (subject entity, event type, anticipated date window) and tolerates lag between the leading and lagging venue.
- **Entity-relative materiality**: Signal scoring is relative to the subject entity, not absolute. A given financing, deal, or readout is interpreted against the entity's current wiki context (size, runway, prior catalysts) rather than against a fixed magnitude threshold.
- **Confidence decomposition**: A signal's confidence is the product of two factors — source trust (the tier of the supporting wiki claims, per the researcher's methodology) and extraction certainty (how unambiguously the event maps to the standing prompt). Both factors are recorded so the researcher's methodology can tune them independently.
- **Idempotent replay**: Re-processing the same source inputs over the same time window must produce no duplicate canonical sources, source findings, wiki claims, or signals.
- **Data integrity**: Monetary values use decimal precision; all timestamps are UTC.
- **Regulatory**: Corporate-action disclosure rules apply.

## 10. Open Questions

- What is the target universe size and expected event volume per researcher?
- What format are the golden documents authored in, and how does the researcher revise them in flight without disrupting active synthesis?
- What is the source-discovery scope — does the methodology enumerate venues exhaustively, or may the system propose new venues for the researcher's approval?
- What scraping cadence, rate limits, and access modes are acceptable per venue category?
- What governs how aggressively the standing prompt is rewritten — time-based, change-volume-based, or event-anticipation-based?
- How are wiki debates surfaced to the researcher (badge on page, queue, digest)?
- What is the confidence threshold that routes a signal to a Reviewer rather than direct delivery?
- What retention period applies to canonical sources, findings, wiki revisions, standing-prompt revisions, and signals?
- How are competing theses (multiple standing prompts per researcher) selected for evaluation against an incoming event?
- What SLA governs Reviewer triage before an unreviewed low-confidence signal expires?
- For Tom's demo, which specific life-sciences sub-niche and which authoritative venues anchor the seed Industry Definition and Research Methodology?

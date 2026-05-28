# Product Requirements Document

## 1. Problem Statement

Event-driven arbitrage hedge fund traders rely on fragmented detection systems—proprietary monitors and external vendors—to identify corporate actions (M&A, dividends, spinoffs). This fragmentation creates latency, missed signals, and signal-to-noise challenges that delay trade execution and reduce arbitrage window capture.

## 2. Goals and Success Metrics

- **Accuracy**: Eliminate false positives and false negatives in corporate action detection within the proscribed universe.
- **Latency**: Sub-second detection and delivery from event source to trader notification; internal processing latency strictly targets <50ms.
- **Volume**: Handle alert volume within the defined security universe without degradation.

## 3. User Roles

- **Trader**: Views alerts, acknowledges them, accesses enriched event details, manages personal watchlists. Executes arbitrage trades based on alerts.
- **Analyst**: Reviews AMBER-tier alerts where data is ambiguous or incomplete before trader delivery. Can escalate or suppress.
- **Admin**: Manages data source configuration, monitors system health, overrides alerts when necessary, maintains audit trails.

## 4. User Stories

- As a Trader, I want to receive fresh alerts on P0 corporate actions affecting my watchlist so that I can identify arbitrage opportunities before market inefficiencies close.
- As a Trader, I want to see deduplicated, enriched event details (terms, impact, spread estimates) so that I can make rapid trade decisions.
- As a Trader, I want to configure watchlists by ticker or event type so that I only receive alerts relevant to my strategy.
- As an Analyst, I want to review flagged AMBER alerts and approve or suppress them so that traders receive only high-confidence signals.
- As an Admin, I want to configure and manage upstream data sources so that I can maintain detection quality and coverage.
- As an Admin, I want to override or suppress false-positive alerts so that I can tune system behavior without code changes.

## 5. Core Workflows

**Happy Path:**

1. Corporate action event is detected from one or more upstream sources via pluggable adapters.
2. Raw event is normalized into a structured observation.
3. System detects event type and extracts structured fields (pricing, ratios, effective dates) specific to the P0 event class.
4. System deduplicates against recent alerts using a composite key (ticker + event type + date).
5. Alert is routed by confidence tier:
   - **GREEN**: High-confidence, deterministic rules → direct trader delivery.
   - **AMBER**: Ambiguous or incomplete data → analyst review queue before delivery.
6. Trader receives alert via outbound channel (email, SMS, webhook).
7. Trader reviews enriched details in UI and acknowledges alert.
8. System records event for replay and lifecycle tracking.

**Edge Cases:**

- Duplicate events from multiple release mechanisms (press release, SEC filing, vendor alert).
- Noisy or incomplete announcements (footnotes, unstructured text in press releases with tables).
- Messy SEC filings requiring text extraction and normalization.
- Out-of-order arrival of correlated events.
- NLP/text extraction service unavailable — system must degrade gracefully using fixture data.

## 6. Entity Lifecycle

**Alert**

- States: Pending → Detected → Enriched → Deduplicated → Routed (GREEN or AMBER) → Delivered → Acknowledged → Archived
- Transitions: Auto-advance through Pending→Detected→Enriched→Deduplicated→Routed; GREEN routes directly to Delivered; AMBER routes to Analyst review before Delivered; Trader manually transitions to Acknowledged; system auto-archives after retention period.

**Corporate Action**

- P0 Event Types: M&A (announced/rumored), tender offers, spinoffs, special dividends, rights offerings, bankruptcies, proxy fights.
- States: Announced → Effective → Closed → Disputed
- Transitions: Auto-advance Announced→Effective on effective date; advance to Closed post-settlement; transition to Disputed if legal challenge or regulatory action occurs.

**Trade**

- States: Proposed → Executed → Settled → Reconciled
- Transitions: Trader proposes (manual or auto); executes (manual or API); settles on settlement date; reconciles on post-trade audit.

## 7. Integration Needs

- **Real-time event feeds**: Pluggable adapters for corporate action announcements from SEC filings and trusted wire services.
- **Data enrichment**: Terms extraction, delta-neutral impact calculation, text parsing and normalization. NLP/text extraction is optional and must degrade gracefully.
- **Outbound alerting**: Multi-channel delivery (email, SMS, webhook, trading platform API integration).
- **Event streaming and replay**: Capability to replay historical fixture data for analysis, debugging, and demonstration.

## 8. Out of Scope

- Generative AI for alert generation, triggering, or routing decisions.
- Cryptocurrency and commodity asset classes.
- Historical backtesting of alert performance.
- Automated trade execution.
- Premium vendor data credentials for V1; replayable fixture data is sufficient.

## 9. Constraints

- **Regulatory**: SEC regulations apply; compliance with corporate action disclosure requirements.
- **Audit Trail**: Minimal audit logging for MVP; enhanced compliance and audit capabilities in post-MVP phases.
- **Performance**: Sub-second latency from event detection to trader notification; internal processing strictly <50ms.
- **Deduplication**: System must deduplicate across multiple detection sources using a composite key of ticker, event type, and date.
- **Replay**: System must support full event replay for debugging and demonstration.
- **AI Prohibition**: Generative AI must not be used for alert triggering or routing decisions. NLP/LLMs are permitted only for optional text extraction and must degrade gracefully when unavailable.
- **Data Integrity**: Monetary values must use decimal precision; all timestamps must be UTC.
- **V1 Scope**: Single-process service with embedded data storage and a plain web UI. No premium vendor credentials required.
- **User Interface**: Basic UI required for viewing, acknowledging, and filtering alerts.

## 10. Open Questions

- What is the target universe size (number of securities)? This drives data ingestion and storage scale.
- What is the expected alert volume per day, per hour, per second? This informs infrastructure scaling.
- Should traders have fine-grained filtering by event type, sector, or deal size?
- What enrichment data is critical vs. nice-to-have for initial release (e.g., delta-neutral impact vs. estimated arbitrage spread)?
- Should the system support webhook-based integration with external trading systems, or is UI-driven decision-making sufficient for MVP?
- What is the SLA for AMBER analyst review — how long before an unreviewed AMBER alert auto-expires or escalates?

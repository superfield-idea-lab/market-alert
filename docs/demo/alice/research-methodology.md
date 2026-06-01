# Research Methodology — Alice

> Author: Alice. Golden document. Agents read it; agents do not write to
> it. Methodology drift, agent suggestions, and learnings live in
> methodology meta-commentary, never here.

## 1. Purpose

How I discover, gather, evaluate, weight, and rank information about
the small-cap clinical-stage biotech names in my Industry Definition.
The defining constraint of my work is **market-moving**: I am not
trying to capture all corporate news, only events that discretely move
a name on the day they surface. Anything that does not meet that bar
belongs on the wiki as context, not as a trade trigger.

## 2. Source Tiers

I rank every information source into a tier. Higher tiers are
weighted more heavily in the wiki, and contradictions are resolved
toward the higher tier unless this section says otherwise.

### Tier A — Primary, regulatory / canonical filings

- SEC EDGAR: 8-K (with item number), 10-K, 10-Q, S-3, 424B5, DEF 14A,
  13D / 13G, Form 4.
- FDA: Drugs@FDA, AdCom briefing documents and outcomes, approval
  letters, CRLs, REMS postings.
- ClinicalTrials.gov registry entries and status updates (NCT IDs).
- EMA / PMDA equivalents for non-US-relevant assets.

### Tier B — Primary, scientific

- Peer-reviewed journals.
- Late-breaking abstracts and oral presentations from canonical
  society meetings (ASCO, ASH, AHA, AACR, ESMO, etc., as applicable to
  the asset's indication).
- Investigator-disclosed primary data (slides, posters) when archived.

### Tier C — Issuer-direct

- Press-release wires: Business Wire, GlobeNewswire, PR Newswire.
- Company IR page postings and pipeline-page snapshots (with date).
- Earnings call transcripts and investor-day decks.

**Critical note on Tier C wires.** Tier 1 market-moving news (clinical
readouts, regulatory actions, deals, safety events) breaks on a
press-release wire **first**. The corresponding 8-K can lag by up to
four business days. For these event types the wire is the
latency-critical source; the 8-K is corroboration, not lead.

### Tier D — Secondary analysis

- Named sell-side analysts listed in §6.
- Specialist trade publications (BioPharma Dive, Endpoints News,
  FierceBiotech, STAT) with a primary citation.

### Tier E — Signal, not evidence

- Social media, forums, aggregator feeds, message boards.
- Useful for "something is happening"; never sufficient on their own.

## 3. Discovery — Where to look

- **Venue:** SEC EDGAR.
  - Entry point: `data.sec.gov` submissions JSON for each CIK on the
    watchlist; full-text search keyed to indication / mechanism
    keywords from the Industry Definition; daily index for catch-up.
  - Cadence: Continuous polling, respecting SEC fair-access (declared
    User-Agent, ≤10 req/s, backoff on 429).
  - What counts as a finding: Any new submission for a watchlist CIK;
    routing rules in §5.
- **Venue:** Press-release wires (BW / GNW / PRN).
  - Entry point: Vendor feed if available; otherwise IR-page polling
    keyed to watchlist tickers.
  - Cadence: High-frequency polling.
  - What counts as a finding: Any new release for a watchlist issuer.
- **Venue:** clinicaltrials.gov.
  - Entry point: API v2, keyed to NCT IDs registered for watchlist
    issuers in the Industry Definition.
  - Cadence: Daily diff.
  - What counts as a finding: `overall_status` flip to Suspended /
    Terminated; material primary-completion date shift; new arm;
    results posting. Trivial registry edits do not count.
- **Venue:** FDA (openFDA, Drugs@FDA, AdCom calendar).
  - Entry point: openFDA API; AdCom calendar page.
  - Cadence: Daily.
  - What counts as a finding: Approval, CRL, AdCom outcome, scheduled
    AdCom date.

Anything from a venue not listed here is out of scope until I add it.

## 4. Evaluation — How to judge a finding

For every finding the wiki captures, the system records:

1. **Provenance** — exact source, tier, retrieval timestamp, content
   hash.
2. **Specificity** — is the claim about a specific asset, indication,
   trial (NCT), endpoint, dose, or population? Vague claims are
   downweighted.
3. **Numeracy** — does the finding carry a number (n, effect size,
   p-value, hazard ratio, response rate, deadline, dollar figure)?
   Numeric findings beat narrative findings.
4. **Corroboration** — is the claim supported by another Tier A or B
   source? Independent corroboration upgrades confidence. Wire and
   subsequent 8-K of the same real-world event collapse to one finding
   (cross-venue dedup), not two.
5. **Stale / superseded** — newer wins by default, but Tier A trumps
   tier-skipping recency.

**Biotech-specific evaluation rules.**

- **8-K item map (deterministic catchers).** When a finding is an 8-K,
  use the item number to short-circuit classification where possible:
  - Item 1.01 Material Definitive Agreement → deal or financing;
    disambiguate by exhibit content.
  - Item 1.02 Termination of Material Definitive Agreement → program
    change / partnership loss.
  - Item 3.01 Delisting / failure to satisfy listing rule →
    financing / solvency.
  - Item 3.02 Unregistered Sales of Equity → financing (dilution).
  - Item 4.01 Change in Certifying Accountant → governance.
  - Item 4.02 Non-Reliance on Prior Financials → governance
    (restatement).
  - Item 5.02 Departure of Directors/Officers → governance; apply
    catalyst-calendar timing filter (proximity to expected readout
    elevates weight).
  - Item 8.01 / 7.01 + Exhibit 99.1 → narrative; classify by content,
    not by item number. The science events (readout, hold, safety)
    arrive here and have no dedicated item number.
- **Spin detection (readouts).** Issuers frame missed primaries as
  wins. When a readout claim is positive in narrative, check
  extracted endpoint data: did the primary hit, is the p-value
  disclosed, is the framing pivoting to a secondary endpoint? If
  framing disagrees with the data, the finding carries a `spin_flag`.
- **Catalyst-calendar context.** The wiki maintains expected catalysts
  per issuer (PDUFA dates, readout windows, AdCom dates). A finding
  inside a calendar window carries higher prior weight. **Silent
  passage** — an expected catalyst date elapsing with no detected
  event — is itself a finding (bearish by default).
- **Halts.** A trading halt (T1 / T12) near a known catalyst is itself
  a finding; do not require an accompanying disclosure to register it.

## 5. Ranking — How findings become wiki claims

- A wiki claim is allowed if it is supported by at least one Tier A or
  Tier B finding, OR by two Tier C findings that do not contradict.
- A Tier D or E finding may annotate a claim but cannot stand alone.
- Where two findings contradict, the higher tier wins; equal-tier
  contradictions become an open Wiki Debate.
- Numeric claims must carry their unit and source. No bare numbers.
- Routine boilerplate disclosures (planned officer retirements,
  registered-shelf housekeeping, periodic-report cover items with no
  new content) annotate the wiki but never produce a candidate signal.

## 6. Trusted Analysts and Experts

_Seed list intentionally empty._ I add named voices here over time;
until a name appears, all sell-side and trade-publication coverage is
treated as ordinary Tier D. Names trusted only within the listed
indication area; outside, treat as ordinary Tier D.

## 7. Red Flags — Things that automatically demote a source

- Press release announcing topline efficacy with no p-value, no n, and
  no effect size.
- Pipeline-page edit not corroborated by a filing or wire.
- Re-statements of prior data presented as new ("encouraging update").
- Conference abstracts whose corresponding presentation was withdrawn.
- Late-Friday or pre-holiday drops bundling bad news with unrelated
  positive items.
- Trade-publication coverage with promotional language and no primary
  citation.

## 8. Thesis-Forming Heuristics

How findings on the wiki are combined into a per-issuer view.

- **Mechanism plausibility** — does the asset's mechanism have prior
  human validation in the indication?
- **Endpoint integrity** — primary endpoint clinically meaningful, not
  just statistically significant.
- **Competitive landscape** — count of competing assets at the same
  stage in the same indication.
- **Cash runway vs. next catalyst** — months of cash relative to the
  next material readout or regulatory date.
- **Management track record** — prior approvals, prior CRLs.
- **Capital structure** — share count, warrants, ATM activity, recent
  dilution.

Per-issuer weights live on the issuer's wiki page, not here.

## 9. Trade-Trigger Conditions

Which catalyst types fire an actionable signal vs. only annotate the
wiki. (Catalyst type definitions live in §7 of the Industry
Definition.)

- **Fire a signal on:**
  - Clinical readout (efficacy) — including spin-flagged readouts.
  - Regulatory action (approval, CRL, AdCom outcome, clinical hold,
    key designation).
  - Safety event (death, serious SAE, dose pause, DSMB stop, registry
    flip to Suspended / Terminated).
  - Financing / solvency event (dilutive offering, going-concern flag,
    reverse split, delisting notice).
  - M&A or major partnership.
  - Program change (asset abandonment, pipeline reprioritization).
  - Governance red flag (auditor resignation, restatement, abrupt
    C-suite exit near a catalyst).
  - Trading halt near a known catalyst.
  - Silent catalyst-date passage (expected catalyst elapsed with no
    detected event).
- **Annotate only:**
  - Insider Form 4, 13D/G activity, peer-name readouts that affect a
    watchlist issuer's competitive landscape, conference scheduling
    announcements, routine periodic-filing cover items.

## 10. What this document is not

- It is not the wiki. Findings, claims, and per-issuer views live in
  the wiki, not here.
- It is not a trade journal. Specific past trades and outcomes belong
  elsewhere.
- It is not auto-updated. Drift, suggestions, and learnings from
  agents accumulate in methodology meta-commentary; I am the only one
  who edits this file.

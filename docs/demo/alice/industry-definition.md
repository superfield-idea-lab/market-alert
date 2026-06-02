# Industry Definition — Alice

> Author: Alice. Golden document. Agents read it; agents do not write to
> it. Scope-drift observations from agents accumulate in methodology
> meta-commentary, never here.

## 1. Purpose

I cover small-cap, clinical-stage biotech. I track these companies
because they are dominated by discrete catalysts — a single readout, a
single regulatory action, a single financing — and a small number of
discrete events move them on the day they surface. Anything that does
not move on the day is, for my purpose, not in scope.

## 2. Sub-Industry / Niche Definition

- **Parent industry:** Health care.
- **Sub-industry:** Biotechnology.
- **Niche:** Small-cap, clinical-stage biotechnology issuers.
- **Inclusion test:** An entity belongs in this niche if and only if
  it is a US-listed biotech with market cap below the small-cap
  threshold (see §9) **and** has at least one asset in clinical
  development (Phase 1, 2, or 3) and **no** approved commercial
  product material to revenue.

## 3. Geographic and Market Scope

- **Listing venues in scope:** NASDAQ, NYSE, NYSE American.
- **Headquarters jurisdictions in scope:** United States. Foreign
  issuers (ADRs) included when the primary listing is US.
- **Operating jurisdictions in scope:** Any — trials are global.
- **Currency reporting expectations:** USD.

## 4. Sub-Segments

- **Sub-segment:** Pre-pivotal clinical (Phase 1, Phase 2).
  - Definition: Lead asset has not yet entered a pivotal/Phase 3 study.
  - Why it matters separately: Catalyst risk is dominated by early
    efficacy and safety, and by financing runway through the next
    readout.
- **Sub-segment:** Pivotal / registrational (Phase 3, BLA/NDA pending).
  - Definition: Lead asset in Phase 3 or with a pending regulatory
    submission.
  - Why it matters separately: Catalyst risk is dominated by pivotal
    readouts, PDUFA dates, and AdCom outcomes.
- **Sub-segment:** Distressed / refinancing.
  - Definition: Cash runway under four quarters, regardless of phase.
  - Why it matters separately: Financing and going-concern catalysts
    dominate every other consideration.

## 5. Watchlist

The list of entities the system tracks for me. Tickers are
authoritative; names and listing venues disambiguate. The table below
is a seed of illustrative clinical-stage names; I revise it as I take
on or drop coverage. Agents may **propose** additions via methodology
meta-commentary; they may not edit the table.

| Ticker | Name                 | Listing | Sub-Segment          | Notes                            |
| ------ | -------------------- | ------- | -------------------- | -------------------------------- |
| VKTX   | Viking Therapeutics  | NASDAQ  | Pre-pivotal clinical | MASH and obesity programs        |
| RVMD   | Revolution Medicines | NASDAQ  | Pre-pivotal clinical | KRAS-inhibitor oncology platform |
| IMVT   | Immunovant           | NASDAQ  | Pre-pivotal clinical | Anti-FcRn immunology             |
| KYMR   | Kymera Therapeutics  | NASDAQ  | Pre-pivotal clinical | Targeted protein degradation     |
| ANNX   | Annexon              | NASDAQ  | Pre-pivotal clinical | Complement-targeted neurology    |

These are seed examples I picked to exercise the system across
sub-segments and indications; the operational watchlist is whatever
this table says at the time the agents read it.

## 6. Key Non-Issuer Actors

Entities that move the niche but are not issuers themselves. Each
becomes a wiki page so claims can attach to it.

- **Actor:** US Food and Drug Administration (FDA).
  - Role: Issues approvals, complete response letters (CRLs), clinical
    holds, AdCom outcomes, designations (Breakthrough, Fast Track,
    Orphan, RMAT).
- **Actor:** European Medicines Agency (EMA).
  - Role: Equivalent decisions for EU-relevant assets.
- **Actor:** Independent Data Monitoring Committees (DSMBs / IDMCs).
  - Role: Recommendations that stop or modify ongoing trials.
- **Actor:** Large-cap pharma counterparties.
  - Role: Source of acquisitions and licensing deals; their pipeline
    decisions affect competitive intensity.

## 7. Catalyst Taxonomy

The event types that matter in this niche. Which of these fire trade
signals vs. only annotate the wiki is decided in §9 of my Research
Methodology — not here.

- **Catalyst:** Clinical readout (efficacy).
  - Where it surfaces: Press release first, 8-K Item 8.01/7.01 with
    Exhibit 99.1, sometimes conference abstract.
  - Typical lead time: Hours to days from registered topline window.
- **Catalyst:** Regulatory action.
  - Where it surfaces: FDA press, company 8-K, Drugs@FDA.
  - Typical lead time: PDUFA-bounded.
- **Catalyst:** Safety event.
  - Where it surfaces: Press release, 8-K Item 8.01, trial-registry
    status change to Suspended/Terminated.
  - Typical lead time: Often delayed; track registry diffs in parallel.
- **Catalyst:** Financing / solvency event.
  - Where it surfaces: 8-K Item 1.01 / 3.02, 424B5 prospectus, Item
    3.01 delisting notice, going-concern language in 10-K/Q.
- **Catalyst:** M&A or major partnership.
  - Where it surfaces: Press release first, 8-K Item 1.01 with
    definitive agreement as exhibit.
- **Catalyst:** Program change / pipeline discontinuation.
  - Where it surfaces: 8-K Item 1.02, earnings call, pipeline-page
    diff.
- **Catalyst:** Governance red flag.
  - Where it surfaces: 8-K Item 4.01 (auditor), 4.02 (restatement),
    5.02 (officer departure) — timing-filtered against catalyst
    calendar.
- **Catalyst:** Trading halt (T1 / T12).
  - Where it surfaces: Exchange notice.
- **Catalyst:** Insider transactions (Form 4) and 13D/G activity.
- **Catalyst:** Routine periodic filings (10-K/Q boilerplate, planned
  retirements, registered-shelf housekeeping).

## 8. Glossary

- **CRL** — Complete Response Letter; FDA refusal to approve as
  submitted.
- **PDUFA** — Prescription Drug User Fee Act target action date.
- **AdCom** — FDA Advisory Committee meeting.
- **DSMB / IDMC** — Data Safety Monitoring Board / Independent Data
  Monitoring Committee.
- **REMS** — Risk Evaluation and Mitigation Strategy.
- **NCT ID** — clinicaltrials.gov registry identifier.
- **424B5** — Prospectus supplement filed under a shelf registration
  (typically a dilutive offering).
- **Going concern** — Auditor language indicating substantial doubt
  about a company's ability to continue operating.
- **Pivotal** — A trial whose result is intended to support
  registration (typically Phase 3, occasionally Phase 2).
- **Spin** — Issuer framing of a missed primary endpoint as a positive
  outcome.

## 9. Explicit Inclusions and Exclusions

- **Small-cap threshold:** Market cap at or below $2B at last close.
  Names that cross above the threshold remain in scope until next
  quarterly review.
- **Include** even though §2 is ambiguous: Issuers with one approved
  product whose revenue is immaterial (e.g. ex-US royalty only).
- **Exclude** even though §2 looks like it covers them: Pre-clinical
  issuers with no IND on file — out of scope until first Phase 1
  authorization.
- **Out of scope entirely** (do not scrape, do not ingest, do not
  alert): Mid- and large-cap commercial-stage pharma, generic
  manufacturers, diagnostics, medical devices, tools/services,
  biotech-adjacent SPACs without an asset.

## 10. What this document is not

- It is not the wiki. Per-entity claims and analysis live in the wiki,
  not here.
- It is not the methodology. How sources are weighed and ranked lives
  in the Research Methodology, not here.
- It is not auto-updated. Suggested watchlist changes, suggested
  sub-segments, and suggested catalyst additions from agents accumulate
  in methodology meta-commentary; I am the only writer of this file.

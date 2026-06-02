# Research Methodology

> **Template — project-wide.** This file is the canonical outline every
> researcher fills in when onboarding. The completed document is a
> **golden document**: only the researcher edits it; agents read it but
> never write to it. Anything an agent learns about methodology drift is
> recorded in methodology meta-commentary, not here.
>
> Replace each `_[…]_` placeholder. Leave headings intact so downstream
> agents can parse the document deterministically.

## 1. Purpose

A short paragraph in your own voice: what this methodology is for, what
universe of decisions it governs, and what is explicitly out of its
scope. Anything outside this document is either out of scope or — if
learned later — belongs in methodology meta-commentary, not in this
file.

_[…]_

## 2. Source Tiers

Rank every information source into a tier. Higher tiers are weighted
more heavily in the wiki, and contradictions are resolved toward the
higher tier unless this section says otherwise.

For each tier, list the venue categories you trust at that level.

### Tier A — Primary, regulatory / canonical filings

_[…]_

### Tier B — Primary, expert / scientific

_[…]_

### Tier C — Issuer-direct

_[…]_

### Tier D — Secondary analysis

_[…]_

### Tier E — Signal, not evidence

_[…]_

## 3. Discovery — Where to look

For each Tier A–C venue, list the entry point the system should poll,
the cadence, and what counts as a "new finding worth ingesting."
Anything from a venue not listed here is out of scope until you add it.

- Venue: _[…]_
  - Entry point: _[…]_
  - Cadence: _[…]_
  - What counts as a finding: _[…]_

(Repeat per venue.)

## 4. Evaluation — How to judge a finding

For every finding the wiki captures, the system records:

1. **Provenance** — exact source, tier, retrieval timestamp, content
   hash.
2. **Specificity** — is the claim specific (named entity, named
   attribute, named value) or vague? Vague claims are downweighted.
3. **Numeracy** — does the finding carry a number (count, magnitude,
   probability, deadline, dollar figure)? Numeric findings beat
   narrative findings.
4. **Corroboration** — is the claim supported by another Tier A or B
   source? Independent corroboration upgrades confidence.
5. **Stale / superseded** — is there a newer finding on the same fact?
   Newer wins by default, but Tier A trumps tier-skipping recency.

Add any researcher-specific evaluation rules here.

_[…]_

## 5. Ranking — How findings become wiki claims

Rules that govern when a finding is allowed to appear as a claim on a
wiki page, and how contradictions are resolved.

- A wiki claim requires _[…]_ supporting findings of which tiers.
- Tier D or E findings _[may / may not]_ stand alone.
- Equal-tier contradictions become a Wiki Debate rather than a silent
  pick.
- Numeric claims must carry their unit and source. No bare numbers.

Add any researcher-specific ranking rules.

_[…]_

## 6. Trusted Analysts and Experts

A short, named list of voices weighted inside Tier D. Names belong
here, not in the wiki. For each, list the sub-area in which they are
trusted; outside that area, treat as ordinary Tier D.

- _[name]_ — trusted in _[area]_
- _[…]_

## 7. Red Flags — Things that automatically demote a source

A finite list of patterns that downgrade a source on sight.

- _[…]_

## 8. Thesis-Forming Heuristics

How findings on the wiki are combined into a per-entity view. List the
factors and the rough direction each one pushes.

- _[factor]_ — what it tells you, when it dominates.
- _[…]_

Per-entity weights belong on each entity's wiki page, not here.

## 9. Trade-Trigger Conditions

Which event types, when evaluated against the standing prompt, should
fire an actionable trade signal — and which should only annotate the
wiki.

- Fire a signal on: _[…]_
- Annotate only: _[…]_

## 10. What this document is not

- It is not the wiki. Findings, claims, and per-entity views live in
  the wiki, not here.
- It is not a trade journal. Specific past trades and outcomes belong
  elsewhere.
- It is not auto-updated. Drift, suggestions, and learnings derived by
  agents accumulate in methodology meta-commentary; the researcher is
  the only writer of this file.

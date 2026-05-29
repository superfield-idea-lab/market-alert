# Industry Definition

> **Template — project-wide.** This file is the canonical outline every
> researcher fills in when onboarding. The completed document is a
> **golden document**: only the researcher edits it; agents read it but
> never write to it. Anything an agent learns about scope drift is
> recorded in methodology meta-commentary, not here.
>
> Replace each `_[…]_` placeholder. Leave headings intact so downstream
> agents can parse the document deterministically.

## 1. Purpose

A short paragraph in your own voice: what industry, sub-industry, or
niche this document covers, and why you track it. This sets the
boundary of every wiki page, every scrape target, and every signal the
system will produce on your behalf.

_[…]_

## 2. Sub-Industry / Niche Definition

A precise statement of the niche. Include:

- The parent industry (broad sector).
- The sub-industry (mid-level grouping).
- The niche (the narrow slice you actually care about).
- A one-sentence inclusion test: "An entity belongs in this niche if
  and only if _[…]_."

_[…]_

## 3. Geographic and Market Scope

Where listed, where headquartered, where operating. Agents will only
follow venues and events inside this scope unless an entry under
§9 explicitly extends it.

- Listing venues in scope: _[…]_
- Headquarters jurisdictions in scope: _[…]_
- Operating jurisdictions in scope: _[…]_
- Currency reporting expectations: _[…]_

## 4. Sub-Segments

Decompose the niche into the sub-segments you reason about
separately. Each sub-segment becomes its own wiki page.

- Sub-segment: _[name]_
  - Definition: _[…]_
  - Why it matters separately: _[…]_

(Repeat per sub-segment.)

## 5. Watchlist

The list of entities the system tracks for you. Tickers are
authoritative; names and listing venues disambiguate. Group by
sub-segment when useful.

| Ticker | Name  | Listing | Sub-Segment | Notes |
| ------ | ----- | ------- | ----------- | ----- |
| _[…]_  | _[…]_ | _[…]_   | _[…]_       | _[…]_ |

Additions and removals happen in this document only. Agents may
**propose** changes via methodology meta-commentary; they may not
edit the table.

## 6. Key Non-Issuer Actors

Entities that move the niche but are not on the watchlist: regulators,
payers, standard-setters, key counterparties, dominant customers,
litigants. Each becomes a wiki page so claims can attach to it.

- Actor: _[name]_
  - Role in the niche: _[…]_
  - Why we track them: _[…]_

(Repeat per actor.)

## 7. Catalyst Taxonomy

The event types that matter in this niche. The system uses this list
to know what to watch for and to route incoming events to the right
wiki entities. Whether each catalyst fires a trade signal or only
annotates the wiki is decided in §9 of the Research Methodology, not
here — that is the single source of truth for routing.

- Catalyst type: _[…]_
  - Where it surfaces: _[…]_
  - Typical lead time: _[…]_

(Repeat per catalyst type.)

## 8. Glossary

Niche-specific terms, mechanisms, abbreviations, and entity classes
the system must recognize when scraping and synthesizing. Keep this
short — definitions only, no commentary.

- _[term]_ — _[definition]_
- _[…]_

## 9. Explicit Inclusions and Exclusions

Edge cases the inclusion test in §2 does not cleanly settle. Pin them
here so the system never has to guess.

- **Include** even though §2 is ambiguous: _[…]_
- **Exclude** even though §2 looks like it covers them: _[…]_
- **Out of scope entirely** (do not scrape, do not ingest, do not
  alert): _[…]_

## 10. What this document is not

- It is not the wiki. Per-entity claims and analysis live in the wiki,
  not here.
- It is not the methodology. How sources are weighed and ranked lives
  in the Research Methodology, not here.
- It is not auto-updated. Suggested watchlist changes, suggested
  sub-segments, and suggested catalyst additions from agents accumulate
  in methodology meta-commentary; the researcher is the only writer of
  this file.

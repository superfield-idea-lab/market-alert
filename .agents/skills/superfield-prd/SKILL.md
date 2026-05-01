---
name: superfield-prd
description: Conduct a structured Product Owner interview and produce a validated PRD. Flags violations (status updates, technical/architectural decisions, vendor commitments) before the document is accepted.
---

# Superfield PRD

Interview → synthesize → violation-check → commit. A PRD describes what users
need and why — not how the system is built, who supplies it, or what exists now.

---

## Phase 1 — Interview

If no description is provided: ask for 2–3 sentences. Do not proceed until it exists.

If the description is too vague to answer Category 1: ask one clarifying question about the core user goal. Do not present the full questionnaire until it is answered.

Pre-fill every answer below from the description. Use multiple-choice where you cannot infer. Present the entire questionnaire in one message — never one question at a time.

**Category 1 — Vision**
- What core problem does this solve, and for whom?
- How do users solve it today, and why is this better?
- What does success look like for the primary user?

**Category 2 — Workflows & Entities**
- Describe the happy-path from sign-up to primary goal achieved.
- What are the most common edge cases or alternative paths?
- Which entities have meaningful lifecycle states? List each with its states and transitions.

**Category 3 — Roles & Access**
- What distinct user roles exist?
- What can each role access, create, update, or delete? What is restricted?
- Does authorization depend on relational conditions (e.g. scope to own department)?
- Is there a user/customer distinction that affects access control?

**Category 4 — Integration Needs**
- What categories of external capability are required (e.g. payment processing, transactional email, identity verification)? Name categories, not vendors.
- What business events trigger each integration?

**Category 5 — Scope & Constraints**
- What is out of scope for the initial release?
- What regulatory, compliance, or accessibility constraints apply?
- What are non-negotiables for launch?

After presenting: wait for confirmation. If the Product Owner rejects answers extensively, update in place, re-present, and wait again. Do not proceed to Phase 2 until confirmed.

---

## Phase 2 — Synthesize

Write `docs/prd.md`:

```markdown
# Product Requirements Document

## 1. Problem Statement
## 2. Goals and Success Metrics
## 3. User Roles
## 4. User Stories
<!-- "As a [role], I want to [action] so that [goal]." One minimum per role. -->
## 5. Core Workflows
## 6. Entity Lifecycle
## 7. Integration Needs
<!-- Capability categories only. No vendor names. -->
## 8. Out of Scope
## 9. Constraints
## 10. Open Questions
```

---

## Phase 3 — Violation check

Scan every section. Fix all violations before presenting. Do not present a document that fails.

- **V1 Status updates** — flag: "currently", "already", "we have", "we built", "exists today", "in progress", "done", "completed", "at present", "right now". Fix: rewrite in forward-looking product voice ("users can…", "the system supports…").
- **V2 Tech/arch decisions** — flag: database names (PostgreSQL, Redis), framework names (Next.js, Rails, Django), infra (AWS, Docker, Kubernetes), protocols (REST, GraphQL, WebSocket), language choices, architectural patterns (microservices, monolith). Fix: replace with user-facing capability ("data is persisted", "the service updates in real time").
- **V3 Vendor commitments** — flag: named SaaS products in requirements: Stripe, Twilio, SendGrid, Salesforce, HubSpot, Segment, Vercel, Cloudflare, S3, or any other named commercial service. Fix: replace with capability category ("a payment processor", "a transactional email provider").

If violations found: list each (section, offending text, fix applied), apply fixes, re-check. Only present after a clean pass. State "Violation check passed." when clean.

---

## Phase 4 — Confirm and commit

Present the clean PRD. After sign-off:

```
git add docs/prd.md && git commit -m "docs: add product requirements document"
```

`docs/prd.md` is the canonical requirements source for downstream `superfield-feature` intake. Do not create GitHub issues from this skill.

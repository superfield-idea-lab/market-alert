# Product Requirements Document — Superfield KB

<!-- last-edited: 2026-04-10 -->

CONTEXT MAP
this ──feeds──────────▶ GitHub Implementation Plan issue
this ──references─────▶ calypso-blueprint/rules/blueprints/ (arch, auth, data, worker, ux, process)
this ──references─────▶ calypso-blueprint/development/userflow-state-machines.md
this ──references─────▶ docs/technical/embedding.md
this ──references─────▶ docs/technical/security.md
this ──references─────▶ docs/technical/md-file-editing.md

---

## 1. Product Vision

Superfield KB is a CRM knowledge base for relationship managers. It continuously
ingests ground-truth customer interactions — emails, meeting audio, transcripts —
and synthesises a living wiki per customer. A background autolearning agent
(Claude CLI) maintains and refines each wiki. Relationship managers access accurate,
up-to-date customer knowledge without manual curation.

**Core problem:** Customer knowledge is siloed per-RM and degrades on staff change.
Emails, meeting notes, and CRM updates are disconnected. There is no authoritative
picture of a customer's history and interests.

**Value proposition:** One structured wiki per customer, maintained automatically
from primary source data, visible only to authorised relationship managers, improving
continuously as new interactions arrive.

**Success condition for the primary user:** An RM opens a customer record and
immediately sees an accurate wiki page — interests, recent interactions, open topics
— synthesised from emails and meeting transcripts, with citations, requiring no
manual entry.

---

## 2. User Roles

Per AUTH blueprint: agents are first-class participants in the authorisation model
with scoped, short-lived credentials.

| Role                          | Description                                                                    | Data visible                                  |
| ----------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| **Relationship Manager (RM)** | Primary end-user. Manages an assigned customer portfolio.                      | Own customers only (RLS enforced at DB layer) |
| **Department Admin**          | Manages RMs within a department. Can reassign customers.                       | All customers within department               |
| **Global Admin**              | Platform-wide administration and audit.                                        | All customers                                 |
| **Autolearn Worker**          | Ephemeral Claude CLI worker agent. Reads anonymised ground truth, writes wiki. | Assigned (dept, customer) scope only          |
| **Ingestion Worker**          | Ephemeral worker. Processes new ground-truth documents.                        | Assigned (dept, customer) scope only          |

**User vs. Customer distinction:** A User is an authenticated human or worker agent.
A Customer is the managed entity — they are never a system user.

**Identity dictionary access:** The `IdentityDictionary` (PII token → real identity
mapping) is accessible only to Global Admin and the API re-identification service.
RMs see real names in the UI via the re-identification layer; they do not hold
dictionary credentials directly.

---

## 3. Data Model

Per DATA blueprint: ground-truth data and synthetic data are architecturally
separated. Agents operate on anonymised views only.

### 3.1 Ground Truth (immutable, source-of-record)

| Entity           | Description                                                                              | Sensitivity              |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| `Email`          | Ingested via IMAP. Headers, body, metadata.                                              | High — encrypted at rest |
| `AudioRecording` | Uploaded from PWA. File reference + metadata.                                            | High — encrypted at rest |
| `Transcript`     | Generated from audio via AssemblyAI. Structured text with speaker labels and timestamps. | High — encrypted at rest |

All ground-truth text is anonymised at ingestion: PII replaced with stable tokens
before storage. See `docs/technical/security.md`.

### 3.2 Synthetic (agent-maintained, mutable)

| Entity             | Description                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `WikiPage`         | One per customer. Markdown. Versioned — each agent revision creates a new `WikiPageVersion`. |
| `WikiPageVersion`  | Full content snapshot + embedding vector. Linked to source ground-truth items.               |
| `WikiAnnotation`   | Comment thread anchored to a wiki passage. Human-created; agent responds and may auto-close. |
| `CustomerInterest` | Structured interest/topic tags extracted by agent. Used for search and CRM display.          |

### 3.3 Identity Dictionary (access-controlled separately)

| Entity               | Description                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `IdentityDictionary` | Maps anonymisation tokens → real PII (name, email, organisation). Column-level encrypted. |

### 3.4 CRM

| Entity      | Description                                                               |
| ----------- | ------------------------------------------------------------------------- |
| `Customer`  | Core CRM record. Assigned RM, department, status, interests, open topics. |
| `CRMUpdate` | RM-authored note or status change. Linked to customer.                    |

---

## 4. Core Workflows and State Machines

### 4.1 Email Ingestion

**Entry condition:** New email arrives at IMAP endpoint for a monitored account.
**Exit condition:** Email is anonymised, stored, and queued for autolearning.

```
IMAP_RECEIVED
    → ANONYMISING       (worker strips and tokenises PII)
    → STORING           (anonymised email written to Postgres)
    → QUEUED            (ingestion event emitted; autolearn worker triggered)
    → INDEXED           (autolearn worker has processed and updated wiki)

    ANONYMISING → FAILED        (on error; alert raised; raw email discarded)
    STORING     → FAILED        (on DB error; retry up to 3x)
```

### 4.2 Meeting Audio Recording and Transcription

**Entry condition:** RM is authenticated in the PWA and initiates a recording.
**Exit condition:** Transcript is stored with speaker labels and queued for autolearning.

```
IDLE
    → RECORDING         (RM taps record in PWA)
    → UPLOADING         (RM stops recording; audio uploaded to backend)
    → SUBMITTED         (backend submits to AssemblyAI)
    → POLLING           (backend polls AssemblyAI for completion)
    → TRANSCRIBED       (transcript with speaker labels stored in Postgres)
    → QUEUED            (autolearn worker triggered)
    → INDEXED           (wiki updated)

    UPLOADING   → UPLOAD_FAILED     (network error; RM can retry)
    POLLING     → TRANSCRIPTION_FAILED  (AssemblyAI error; stored as failed; RM notified)
```

**Speaker diarisation:** AssemblyAI speaker labels (`SPEAKER_A`, `SPEAKER_B`) are
stored in the transcript. The autolearning agent uses speaker context when extracting
customer interests.

### 4.3 Wiki Autolearning (Cron — Gardening)

**Entry condition:** Scheduled cron fires; Kubernetes creates ephemeral worker pod
scoped to (dept, customer).
**Exit condition:** New WikiPageVersion written; CustomerInterests updated; pod terminates.

```
WORKER_STARTED
    → FETCHING_GROUND_TRUTH     (worker reads anonymised emails + transcripts from Postgres)
    → FETCHING_WIKI             (worker reads current wiki markdown from Postgres)
    → WRITING_TEMP_FILES        (ground truth + wiki written to pod-local /tmp/)
    → CLAUDE_CLI_RUNNING        (Claude CLI reads /tmp/, edits wiki.md)
    → WRITING_NEW_VERSION       (worker reads updated wiki.md; writes new WikiPageVersion to DB via API)
    → EMBEDDING                 (new version embedded; vectors stored in pgvector)
    → COMPLETE                  (pod terminates; /tmp/ destroyed)

    Any state → FAILED          (error logged; previous wiki version remains current)
```

### 4.4 Wiki Correction via Annotation Thread

**Entry condition:** RM selects a passage in the wiki and opens an annotation.
**Exit condition:** Wiki updated; annotation thread resolved.

```
ANNOTATION_OPEN
    → AGENT_RESPONDING      (agent reads thread and current wiki; proposes correction)
    → DISCUSSION            (RM replies; agent responds; thread continues)
    → CORRECTION_APPLIED    (agent writes new WikiPageVersion; marks annotation resolved)

    DISCUSSION → DISMISSED          (RM dismisses without applying)
    CORRECTION_APPLIED → REOPENED   (RM reopens; thread continues)
    AGENT_RESPONDING → AUTO_RESOLVED    (agent confident issue is satisfied; closes thread)
```

### 4.5 On-Demand Deep Clean

**Entry condition:** Admin or Manager triggers deep clean for a specific customer.
**Exit condition:** New WikiPageVersion written from full ground-truth rebuild; pod terminates.

```
DEEPCLEAN_TRIGGERED
    → WORKER_STARTED        (ephemeral pod created; scoped to dept + customer)
    → FETCHING_ALL_GROUND_TRUTH     (all emails + transcripts for customer)
    → CLAUDE_CLI_RUNNING    (Claude CLI rebuilds wiki from scratch; no prior wiki passed)
    → WRITING_NEW_VERSION   (new version written; source = 'deepclean')
    → EMBEDDING
    → COMPLETE
```

### 4.6 CRM Update from PWA

**Entry condition:** RM is viewing a customer record in the PWA.
**Exit condition:** CRMUpdate record written; customer record reflects change.

```
VIEWING_CUSTOMER
    → EDITING           (RM taps edit on a field or adds a note)
    → SAVING            (RM submits change)
    → SAVED             (CRMUpdate written; customer record updated)

    SAVING → CONFLICT       (concurrent edit detected; RM shown diff; must resolve)
    SAVING → FAILED         (DB error; RM notified; change not applied)
```

---

## 5. UX Requirements

Per UX blueprint: service delivery is designed before interfaces. The agent is a
first-class user with a declared presence on the account.

### 5.1 Surfaces

| Surface                           | Users                              | Description                                                  |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| **Web app (browser)**             | RM, Admin                          | Full CRM + wiki navigation, annotation threads, CRM updates  |
| **PWA (mobile)**                  | RM                                 | Audio recording, transcript review, CRM updates in the field |
| **Worker interface (structured)** | Autolearn worker, Ingestion worker | Machine-readable task queue; not a human UI                  |

### 5.2 Wiki View

- Rendered markdown in browser and PWA.
- Annotation threads displayed inline at their anchor position (Google Docs comment
  pattern).
- Multiple threads open simultaneously on one page.
- Thread shows: author, role, timestamp, full dialogue, resolution status.
- Agent responses in threads are visually distinguished from human messages.
- Version history accessible (who/what changed the wiki, when, why).

### 5.3 Agent Visibility

Per UX blueprint: the agent is not a background process operating invisibly. Its
participation is declared and auditable.

- Each WikiPageVersion records `created_by` (worker job id) and `source`
  (autolearn | correction | deepclean).
- RMs can see when the wiki was last updated and by what trigger.
- Agent activity in annotation threads is labelled.

### 5.4 PWA Audio

- Simple record/stop/upload flow.
- Recording state is preserved if the user backgrounds the app mid-recording.
- Upload progress shown; error state with retry.
- Transcript available in customer record once AssemblyAI completes.

---

## 6. External Integrations

| Integration                                 | Purpose                                                   | Notes                                                                                                                    |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **IMAP client**                             | Email ingestion                                           | Existing implementation in `~/calypso-distribution`                                                                      |
| **AssemblyAI**                              | Audio transcription + speaker diarisation                 | Polled (no webhook). Test credentials required.                                                                          |
| **Anthropic API (Claude)**                  | Wiki synthesis, interest extraction, annotation responses | Claude CLI for worker; Anthropic API SDK for annotation agent                                                            |
| **Ollama / in-house Rust embedding server** | Text embeddings for pgvector                              | `nomic-embed-text-v1.5`. Ollama in development; Rust server (`candle`) in production. See `docs/technical/embedding.md`. |

---

## 7. Security Requirements

Full detail in `docs/technical/security.md`. Summary:

- **Row-level security** on all customer data; enforced at Postgres layer.
- **Worker scoping:** each ephemeral pod is issued a Kubernetes service account
  bound to (dept, customer); RLS enforces the boundary at the DB layer.
- **Anonymisation:** PII replaced with stable tokens before any worker reads
  ground-truth data. `IdentityDictionary` is access-controlled separately.
- **Encryption at rest (per DATA blueprint):** Four concentric layers required —
  disk encryption, database-level encryption, application-layer field encryption,
  and KMS-managed keys. Each layer assumes the one below it has been compromised.
  Full-disk alone is insufficient. Column-level encryption (`pgcrypto` /
  application-layer encrypt-before-insert) is required for sensitive fields in
  ground-truth tables and all fields in `IdentityDictionary`.
- **Encryption in transit:** TLS 1.2+ for all external traffic; SSL required for
  all Postgres connections.
- **Identity dictionary access (per AUTH blueprint):** Only roles with explicit
  `can_view_dictionary` scope may query `IdentityDictionary`. RMs do not hold
  this scope. Re-identification for UI display is performed by a dedicated API
  service; the RM session credential never grants dictionary access directly.

---

## 8. Worker Architecture

Per WORKER blueprint: the worker's Postgres role is read-only. All writes pass
through the API layer using a short-lived scoped worker token. The database is
structurally unreachable for writes from the worker container at the network level.

- Workers read ground-truth and current wiki from Postgres via a read-only role.
- Workers submit updated wiki content via `POST /internal/wiki/versions`.
- Workers resolve annotation threads via `POST /internal/wiki/annotations/:id/resolve`.
- The API layer validates, authorises, and commits all writes exactly as it would
  for a human-initiated request.
- Worker tokens are scoped to (dept, customer) and expire at pod termination.

See `docs/technical/md-file-editing.md` for the full worker flow.

---

## 9. Non-Functional Requirements

| Requirement                             | Target                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Wiki update latency (ingestion trigger) | New wiki version available within 5 minutes of ground-truth ingestion completing               |
| Transcription turnaround                | Transcript available within 10 minutes of upload for recordings under 60 minutes               |
| API response time (wiki read)           | p95 < 500ms                                                                                    |
| Availability                            | 99.5% uptime for web app and PWA                                                               |
| Data residency                          | All customer data remains within the Kubernetes cluster; no corpus text transits external APIs |

---

## 10. Open Questions

| Question                                                         | Owner         | Blocks                      |
| ---------------------------------------------------------------- | ------------- | --------------------------- |
| Gardening cron frequency?                                        | Product Owner | Worker scheduling           |
| Which integrations are v1 vs. later? (Google Drive, Slack, etc.) | Product Owner | Implementation Plan scoping |
| AssemblyAI test credentials                                      | Product Owner | Transcription tests         |
| KMS provider for Kubernetes Secret encryption                    | Infra         | Security implementation     |
| mTLS for cluster-internal traffic?                               | Infra         | Security implementation     |

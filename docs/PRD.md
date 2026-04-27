# Product Requirements Document — Superfield KB

<!-- last-edited: 2026-04-10 -->

CONTEXT MAP
this ──feeds──────────▶ GitHub Implementation Plan issue
this ──references─────▶ calypso-blueprint/rules/blueprints/ (arch, auth, data, worker, ux, process)
this ──references─────▶ calypso-blueprint/development/userflow-state-machines.md
this ──references─────▶ docs/technical/db-architecture.md
this ──references─────▶ docs/technical/embedding.md
this ──references─────▶ docs/technical/security.md
this ──references─────▶ docs/technical/md-file-editing.md

---

## 0. Regulatory Scope

**Target regulatory regimes.** Superfield KB is designed to be deployable under:

- **MiFID II** (EU/UK) — record-keeping (Art. 16), communications recording
  (Art. 16(7)), 5-year minimum retention.
- **FCA SYSC 9 / COBS 11.8** (UK) — record-keeping for investment services.
- **FINRA 4511 / SEC 17a-4** (US) — books and records, WORM storage.
- **GDPR** (EU/UK) — lawful basis, data subject rights, DPA with sub-processors.
- **Swiss FINMA** and **MAS (Singapore)** banking-secrecy regimes — data
  residency and confidentiality.

The product does not claim compliance on behalf of the tenant; it provides the
technical controls required for the tenant to achieve compliance under their own
supervisory framework. Regime-specific feature gates (WORM mode, residency
pinning, sub-processor allow-lists) are tenant-configurable.

**Attestations.** The platform targets:

- **SOC 2 Type II** (Security, Availability, Confidentiality) — required before GA.
- **ISO 27001** — targeted within 12 months of GA.
- **DPA available** on request, naming all sub-processors.

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

| Role                                   | Description                                                                                                                                                                                       | Data visible                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Relationship Manager (RM)**          | Primary end-user. Manages an assigned customer portfolio.                                                                                                                                         | Own customers only (RLS enforced at DB layer)                                          |
| **Business Development Manager (BDM)** | Cross-customer reporting and campaign analysis. Can query aggregated meeting data across all customers in their department but receives anonymised output — client identities are never revealed. | Anonymised cross-customer aggregates within department; no individual customer records |
| **Department Admin**                   | Manages RMs within a department. Can reassign customers.                                                                                                                                          | All customers within department                                                        |
| **Global Admin**                       | Platform-wide administration and audit.                                                                                                                                                           | All customers                                                                          |
| **Compliance Officer**                 | Read-only access to audit trail, legal holds, retention status, and e-discovery export. Cannot read customer content.                                                                             | Audit and metadata only                                                                |
| **Autolearn Worker**                   | Ephemeral Claude CLI worker agent. Reads anonymised ground truth, writes wiki.                                                                                                                    | Assigned (dept, customer) scope only                                                   |
| **Ingestion Worker**                   | Ephemeral worker. Processes new ground-truth documents.                                                                                                                                           | Assigned (dept, customer) scope only                                                   |

**User vs. Customer distinction:** A User is an authenticated human or worker agent.
A Customer is the managed entity — they are never a system user.

**Identity dictionary access:** The `IdentityDictionary` (PII token → real identity
mapping) is accessible only to Global Admin and the API re-identification service.
RMs see real names in the UI via the re-identification layer; they do not hold
dictionary credentials directly. BDMs do not hold dictionary access — their queries
operate on anonymised data by design.

---

## 3. Data Model

Per DATA blueprint: ground-truth data and synthetic data are architecturally
separated. Agents operate on anonymised views only.

All product entities — auth, CRM, ground truth, wiki, corpus chunks, campaign
tagging, identity tokens — are modelled as a tenant-scoped property graph.
Entity types are registered in a single registry; adding a new concept is data,
not a schema change. Relations carry all associations between entities. See
`docs/technical/db-architecture.md` for the physical model.

### 3.1 Ground Truth (immutable, source-of-record)

| Entity type      | Description                                                                              | Sensitivity              |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| `Email`          | Ingested via IMAP. Headers, body, metadata.                                              | High — encrypted at rest |
| `AudioRecording` | Uploaded from PWA. File reference + metadata.                                            | High — encrypted at rest |
| `Transcript`     | Generated from audio via AssemblyAI. Structured text with speaker labels and timestamps. | High — encrypted at rest |

All ground-truth text is anonymised at ingestion: PII replaced with stable tokens
before storage. See `docs/technical/security.md`.

All ground-truth entities carry `retention_class` (tenant-policy pointer) and
`legal_hold` (boolean + hold reference) fields enforced at the database layer.
See §7a.

### 3.2 Synthetic (agent-maintained, mutable)

| Entity type        | Description                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WikiPage`         | One per customer. Markdown. Versioned — each agent revision creates a new `WikiPageVersion`.                                                                                                               |
| `WikiPageVersion`  | Full content snapshot + embedding vector. Linked to source ground-truth items.                                                                                                                             |
| `WikiAnnotation`   | Comment thread anchored to a wiki passage. Human-created; agent responds and may auto-close.                                                                                                               |
| `CustomerInterest` | Structured interest/topic tags extracted by agent. Used for search and CRM display.                                                                                                                        |
| `CorpusChunk`      | Anonymised text fragment extracted from an email or transcript. Embedded for similarity search. The unit retrieved and passed to the inference model as context. Linked to its source ground-truth entity. |

### 3.3 Identity dictionary (access-controlled separately)

| Entity type     | Description                                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityToken` | Maps an anonymisation token to the real identity it represents (name, email, organisation). Stored as restrictively-scoped entities: any session without explicit dictionary authority is denied visibility at the database layer, not filtered at the application layer. Field-level encrypted at rest. |

### 3.4 CRM

| Entity type    | Description                                                               |
| -------------- | ------------------------------------------------------------------------- |
| `Customer`     | Core CRM record. Assigned RM, department, status, interests, open topics. |
| `CRMUpdate`    | RM-authored note or status change. Linked to customer.                    |
| `AssetManager` | An external asset management firm the organisation works with.            |
| `Fund`         | A specific product or fund offered by an asset manager.                   |

Transcripts and meetings are tagged with the `AssetManager` and/or `Fund` entities
discussed during the meeting. This tagging enables cross-customer campaign analysis
(see §4.7) without requiring access to individual customer records.

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

The PWA selects a path at recording start based on expected duration and tenant
configuration. Both default paths keep raw audio inside the trust boundary.

**Edge path** (short recordings, tenant default):

```
IDLE
    → RECORDING         (RM taps record in PWA)
    → TRANSCRIBING      (PWA transcribes locally on-device; raw audio never
                         leaves the device)
    → UPLOADING         (RM stops recording; only the transcript is uploaded)
    → TRANSCRIBED       (transcript with speaker labels stored in Postgres)
    → QUEUED            (autolearn worker triggered)
    → INDEXED           (wiki updated)

    TRANSCRIBING → TRANSCRIPTION_FAILED  (on-device model error; RM can fall
                                          back to the worker path)
    UPLOADING    → UPLOAD_FAILED         (network error; transcript retained
                                          locally; RM can retry)
```

**Worker path** (longer recordings):

```
IDLE
    → RECORDING         (RM taps record in PWA)
    → UPLOADING         (RM stops recording; audio uploaded to backend over TLS)
    → TRANSCRIBING      (cluster-internal transcription worker processes the
                         audio; raw audio stays inside the trust boundary)
    → TRANSCRIBED       (transcript with speaker labels stored in Postgres)
    → QUEUED            (autolearn worker triggered)
    → INDEXED           (wiki updated)

    UPLOADING    → UPLOAD_FAILED         (network error; RM can retry)
    TRANSCRIBING → TRANSCRIPTION_FAILED  (worker error; stored as failed; RM notified)
```

**Speaker diarisation:** Both transcription paths emit speaker labels
(`SPEAKER_A`, `SPEAKER_B`). The autolearning agent uses speaker context when
extracting customer interests.

**Legacy path (AssemblyAI).** Available only to non-regulated tenants that have
explicitly opted in (§6). Raw audio is submitted to and polled from AssemblyAI.
Blocked at the tenant-configuration layer for regulated tenants. Not used in
any default configuration.

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
    → AWAITING_REVIEW           (new version written as `draft`; not visible to RMs)
    → PUBLISHED                 (review gate satisfied; version becomes current)
    → COMPLETE                  (pod terminates; /tmp/ destroyed)

    Review gate is satisfied when EITHER:
      (a) the diff against the prior version is below a configured
          materiality threshold (tenant-configurable; default: no
          claims added, only citations or phrasing changes), OR
      (b) an authorised RM or Department Admin explicitly approves
          the draft via the annotation UI.

    AWAITING_REVIEW → REJECTED  (reviewer rejects; draft archived;
                                 prior version remains current)
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
    → AWAITING_REVIEW       (deepclean always requires explicit human approval,
                             regardless of diff materiality)
    → PUBLISHED             (reviewer approves; version becomes current)
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

### 4.7 Cross-Customer Campaign Summary (BDM Workflow)

**Entry condition:** BDM is authenticated and selects an asset manager or fund
from the campaign analysis view.
**Exit condition:** A 1-pager summary of meeting themes is generated and
presented to the BDM. No individual client identities appear in the output.

**Privacy invariant:** The query spans customer records, but the output is
produced entirely on anonymised data. Client tokens (`CUST_xxxx`) are used
throughout; the identity dictionary is never consulted. The BDM cannot derive
which specific clients were in which meetings from the output. This is a
structural guarantee: the BDM's database session cannot read customer entities,
wiki entities, ground-truth emails, customer interests, or identity dictionary
entries, and cannot traverse relations that would link a transcript back to a
customer. These blocks are enforced by restrictive row-level policies at the
database layer, not by application-layer filtering.

```
BDM_SELECTS_ASSET_MANAGER
        |
        v
QUERYING_TAGGED_TRANSCRIPTS
  System finds all transcripts in the BDM's department tagged with the
  selected asset manager or fund. Returns anonymised corpus chunks only —
  customer IDs are token references, not real identities.
        |
        v
GENERATING_SUMMARY
  A Claude API call receives the anonymised transcript chunks and produces
  a structured 1-pager: main themes, key topics discussed, sentiment, and
  frequency of discussion — without referencing individual clients.
        |
        v
SUMMARY_READY
  BDM views and optionally exports the 1-pager.

  QUERYING_TAGGED_TRANSCRIPTS → NO_RESULTS
    (no meetings tagged with this asset manager in the department)
  GENERATING_SUMMARY → FAILED
    (Claude API error; BDM notified; raw chunk list offered as fallback)
```

**Tagging model:**

Transcripts are tagged with `AssetManager` / `Fund` entities via relations at
ingestion time. The autolearning agent identifies which asset managers and funds
were discussed in a meeting and writes `discussed_in` relations:

```
AssetManager / Fund ──discussed_in──▶ Transcript
```

The tag is written to the graph on the anonymised transcript entity — it carries
no client identity. A single transcript can be tagged with multiple asset managers
or funds.

**RLS boundary:**

The BDM query reads transcripts scoped to the BDM's department and joins to
asset manager and fund entities via the `discussed_in` relation. At no point
does the query touch customer records, wiki content, ground-truth emails,
customer interests, or the identity dictionary — all are blocked by restrictive
policies for BDM sessions at the database layer. Relations that would link a
transcript back to a customer (such as `has_ground_truth`) are also blocked,
preventing re-identification via relation traversal even without reading the
customer row directly.

---

## 5. UX Requirements

Per UX blueprint: service delivery is designed before interfaces. The agent is a
first-class user with a declared presence on the account.

### 5.1 Surfaces

| Surface                           | Users                              | Description                                                                                                  |
| --------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Web app (browser)**             | RM, Admin                          | Full CRM + wiki navigation, annotation threads, CRM updates                                                  |
| **PWA (mobile)**                  | RM                                 | Audio recording, transcript review, CRM updates in the field                                                 |
| **Campaign analysis view**        | BDM                                | Select asset manager or fund; generate anonymised meeting summary 1-pager; no individual client data visible |
| **Worker interface (structured)** | Autolearn worker, Ingestion worker | Machine-readable task queue; not a human UI                                                                  |

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
- Transcript available in customer record once transcription completes.

### 5.5 Draft vs. Published Wiki Versions

Every autolearn-generated `WikiPageVersion` is written as a draft and is
invisible to RMs until it clears the publication gate (§4.3). The wiki view
always shows the current _published_ version with a visible "N pending draft
revisions" indicator. Drafts are reviewable inline with a diff against the
current version. Deepclean rebuilds (§4.5) always require explicit human
approval regardless of diff materiality.

---

## 6. External Integrations

| Integration                                             | Purpose                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IMAP client**                                         | Email ingestion                                           | Existing implementation in `~/superfield-distribution`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **AssemblyAI** _(optional, non-regulated tenants only)_ | Audio transcription + speaker diarisation                 | Available only to tenants explicitly opted in under a signed DPA addendum; never enabled by default. Regulated tenants (MiFID II, FCA SYSC, FINRA, GDPR, FINMA, MAS) cannot enable this path — it is blocked at the tenant-configuration layer, not by policy. All other tenants use the edge path (on-device PWA transcription for short recordings) or the worker path (cluster-internal transcription model for longer recordings). Raw audio never leaves the trust boundary on the default path. Polled (no webhook). |
| **Anthropic API (Claude)**                              | Wiki synthesis, interest extraction, annotation responses | Claude CLI for worker; Anthropic API SDK for annotation agent                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Ollama / in-house Rust embedding server**             | Text embeddings for pgvector                              | `nomic-embed-text-v1.5`. Ollama in development; Rust server (`candle`) in production. See `docs/technical/embedding.md`.                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 7. Security Requirements

Full detail in `docs/technical/security.md`. Summary:

- **Row-level security** on all customer data; enforced at Postgres layer.
- **Worker scoping:** each ephemeral pod is issued a Kubernetes service account
  bound to (dept, customer); RLS enforces the boundary at the DB layer.
- **Anonymisation:** PII replaced with stable tokens before any worker reads
  ground-truth data. `IdentityDictionary` is access-controlled separately.
- **Encryption at rest:** Sensitive fields — corpus bodies, transcripts, CRM
  notes and customer names, customer interests, synthesised wiki content,
  recovery shards, and every identity dictionary field — are encrypted at the
  application layer with authenticated symmetric encryption before insert,
  using KMS-managed keys partitioned by sensitivity class. The audit store
  uses a key domain disjoint from all operational keys. Postgres volumes sit
  on encrypted storage.
- **Embedding column threat model.** Vector embeddings for `CorpusChunk`
  entities are stored with storage-layer encryption and row-level security only,
  because field-level encryption is incompatible with HNSW indexing. This is an
  accepted residual risk with the following compensating controls:
  1. **Semantic leakage bound.** Embeddings are generated from _anonymised_
     corpus chunks — PII tokens are already substituted before embedding. An
     attacker with raw embedding access cannot recover names, email addresses,
     or organisation identities without separately compromising the identity
     dictionary (which sits in a disjoint key domain).
  2. **No direct query path.** The embedding column is not exposed via any API
     surface. Similarity search returns `CorpusChunk` IDs, which are then
     re-fetched through the normal RLS-enforced read path. A compromised
     application role cannot dump embeddings via the query API.
  3. **Inversion risk.** We treat embedding inversion (reconstructing source
     text from vectors) as a realistic threat. Mitigations: (a) corpus chunks
     are pre-anonymised, bounding what inversion can recover; (b) embeddings
     are scoped per-tenant and per-department at the row level, so a
     single-tenant compromise cannot cross tenant boundaries; (c) the embedding
     model (`nomic-embed-text-v1.5`) and its dimensionality are
     tenant-configurable, allowing rotation if published inversion attacks
     degrade the assumption.
  4. **Detection.** Bulk reads of the embedding column are audited and
     rate-limited; a read pattern consistent with exfiltration triggers an
     alert to the tenant's security contact.

  This trade-off is contained to the embedding column. No other sensitive field
  relies on storage-layer encryption alone.

- **Audit isolation:** Audit events are written to a dedicated store with its
  own role and its own key domain. The application's operational role cannot
  read or modify audit data. Audit writes precede sensitive reads; a failed
  audit write denies the read.
- **Encryption in transit:** TLS 1.2+ for all external traffic; SSL required
  for all Postgres connections.
- **Key management:** Production deployments use a cloud-provider KMS (AWS KMS,
  GCP KMS, or Azure Key Vault) with HSM-backed root keys, per-tenant data-key
  hierarchies, and automatic rotation on a ≤ 90-day cadence. Key material never
  leaves the KMS boundary. On-prem deployments use HashiCorp Vault in HSM-backed
  mode.
- **Cluster-internal transport:** All pod-to-pod traffic inside the Kubernetes
  cluster is mTLS-encrypted via a service mesh (Linkerd or Istio). Worker → API,
  API → Postgres, and API → embedding-server calls are mutually authenticated
  with short-lived workload identities. Unencrypted internal traffic is blocked
  by network policy.
- **Identity dictionary access (per AUTH blueprint):** Only sessions with
  explicit dictionary authority may see identity token entries; absence of
  authority denies visibility at the database layer, not the application layer.
  RMs, BDMs, and Department Admins do not hold this authority. Re-identification
  for UI display is performed by a dedicated API service that holds the
  authority; end-user session credentials never grant dictionary access directly.
- **Insider-abuse posture:** Every cross-customer read, every identity dictionary
  access, and every BDM campaign query is audited with actor, target, and
  timestamp. Administrative dictionary access requires a scoped, short-lived
  credential — never a long-lived role. The system assumes a compromised
  internal session is as dangerous as an external breach: row-level policies
  are restrictive, not permissive, and structural database blocks replace
  application-layer filtering wherever possible.

---

## 7a. Records Management

**Retention.** Ground-truth entities (`Email`, `AudioRecording`, `Transcript`)
and derived `CorpusChunk` entities are retained per tenant-configured retention
policy, with a minimum floor of the longer of (a) the tenant's regulatory
retention period (e.g. 5 years for MiFID II Art. 16, 6 years for FINRA 4511)
and (b) 1 year. Synthetic entities (`WikiPage`, `WikiPageVersion`) are retained
for the life of the customer record plus the regulatory floor. Deletion before
the floor is blocked at the database layer, not at the application layer.

**WORM mode.** Ground-truth storage can be configured in write-once-read-many
mode per tenant; ingested entities become immutable on commit and cannot be
deleted or modified until retention expires. Required for MiFID II Art. 16(6)
and SEC 17a-4(f) tenants.

**Legal hold.** A Global Admin can place a `LegalHold` on any entity, customer,
or date range. Held entities are exempted from retention-based deletion
regardless of policy expiry. Holds are themselves audited and cannot be removed
without a second admin's approval (four-eyes).

**E-discovery export.** Authorised admins can export a point-in-time bundle
(ground truth + wiki versions + annotations + audit trail) for a given customer,
department, or date range, in a structured format suitable for legal review.
Exports are themselves audit events.

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

| Requirement                             | Target                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wiki update latency (ingestion trigger) | New wiki version available within 5 minutes of ground-truth ingestion completing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Transcription turnaround                | Transcript available within 10 minutes of upload for recordings under 60 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| API response time (wiki read)           | p95 < 500ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Availability                            | 99.9% uptime for web app and PWA during business hours in each tenant's primary region, with service credits on breach                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Wiki accuracy SLA                       | Per published `WikiPageVersion`: every factual claim must cite at least one ground-truth source (`CorpusChunk` reference). Published versions with uncited claims are a P1 defect. Measured by sampled audit against ground truth; target ≥ 99% claim-citation coverage.                                                                                                                                                                                                                                                                                                                 |
| Hallucination escalation                | An annotation resolved with `DISMISSED` against an autolearn-authored passage increments a per-customer confidence counter; three dismissals within 30 days forces the next autolearn version into explicit human-approval mode regardless of materiality.                                                                                                                                                                                                                                                                                                                               |
| Data residency                          | Customer data — raw or anonymised — does not transit external networks, with one named permanent exception: inference calls to Anthropic's private-cloud endpoint under DPA. No other external API (embedding, transcription, summarisation, analytics) may receive corpus text, derived chunks, audio, or vector embeddings. Anonymised data is treated the same as raw data under this rule. The optional AssemblyAI integration (§6) is available only to non-regulated tenants that have explicitly opted in; it is blocked at the tenant-configuration layer for regulated tenants. |

---

## 10. Open Questions

| Question                                                         | Owner         | Blocks                      |
| ---------------------------------------------------------------- | ------------- | --------------------------- |
| Gardening cron frequency?                                        | Product Owner | Worker scheduling           |
| Which integrations are v1 vs. later? (Google Drive, Slack, etc.) | Product Owner | Implementation Plan scoping |

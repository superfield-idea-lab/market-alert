# Rule 3: data — Data Layer

## Summary of the blueprint rule

The DATA blueprint establishes a structural rather than procedural approach to data privacy
and security. Its core thesis is that policy (privacy notices, access-control lists) is
necessary but insufficient; the real protection comes from architectural separation enforced
at the infrastructure layer.

**Three-store model.** Every application must provision three distinct PostgreSQL databases
from the first commit: a transactional store (`*_app`), an analytics store (`*_analytics`),
and an audit store (`*_audit`). These databases run under disjoint roles with disjoint KMS
key domains. No role crosses database boundaries. The analytics store has no foreign keys
back to the transactional store and no mechanism for re-identification.

**Property graph on PostgreSQL.** The transactional store uses a fixed three-table property
graph schema: `entities` (nodes with a `type` and a `properties JSONB` column), `relations`
(typed edges between entities with JSONB properties), and `entity_types` (a live schema
registry holding JSON Schema definitions, sensitivity metadata, and KMS key IDs per type).
Adding a new entity type is an INSERT into `entity_types`, not a DDL migration. The graph
model is the default for all business entities; dedicated relational tables are permitted
only for integrity-critical infrastructure such as ledgers, replay checkpoints, and nonce
stores.

**Layered encryption.** Four concentric layers protect data at rest: disk encryption,
database-level encryption, application-layer AES-256-GCM field encryption, and
(optionally, for V3+) user-held client-side keys. The `entity_types` registry declares
which JSONB properties are sensitive and which `kms_key_id` protects them. The
`FieldEncryptor` intercepts writes, encrypts designated fields before storage, and
decrypts on read. One KMS key per entity type limits blast radius: a single key compromise
exposes only one data domain. Key rotation is a background job, not a cutover.

**Audit-before-access.** Every read of sensitive data is logged to the audit store before
the read executes. If the audit write fails, the data read is denied. The audit store uses
its own encryption key and its own database role (INSERT-only; no UPDATE, DELETE, or
TRUNCATE). The business journal is distinct from the audit log: the journal answers "what
accepted business facts changed state" (replay, compensation), while the audit log answers
"who read, attempted, denied, or administered the system."

**Agent access boundary.** No agent or worker process has arbitrary read access to the
transactional store. Workers interact with the database exclusively through scoped internal
API endpoints; their database role grants SELECT only on task queue views. Analytics queries
run against `*_analytics` only, never against `*_app`. Differential privacy (Laplace noise,
epsilon budget tracking, atomic decrement before query execution) is applied on all
aggregation exports from the analytics tier.

**Schema migration safety.** Migrations follow a three-layer model: (1) `init-remote.ts`
creates databases, roles, tables, and grants with admin credentials — fully idempotent, runs
once; (2) `migrate()` in the app runs idempotent DDL and seeds entity types at startup — no
ALTER TABLE; (3) `migrator.ts` runs versioned ALTER TABLE and data backfill as a separate
k8s Job during deployment rollout with mandatory pre-check, post-check, and a five-checkbox
compatibility review. A running application version must never be rendered inoperable by an
in-flight migration.

**Data minimization.** Every persisted field must be justified by a current product function,
a retention period, and a deletion plan. Automated deletion enforces retention; human
discipline does not.

---

## TypeScript implementation specifics

The TypeScript implementation prescribes concrete choices for every abstract blueprint
requirement.

**Database client.** The `postgres` npm package with its tagged template literal API
(`sql\`SELECT ... WHERE id = ${id}\``). Parameterization is structural — string
concatenation injection is architecturally difficult, not merely discouraged. No ORM
(Prisma, TypeORM, Drizzle): the property graph's JSONB model and the three-pool
architecture are easier to express in direct SQL than through an ORM's schema file and
generation step.

**Encryption.** AES-256-GCM via the Web Crypto API (`crypto.subtle`). No external crypto
library. HKDF key derivation also via `crypto.subtle`. Ciphertext envelope format:
`base64url(keyVersion 4B || iv 12B || ciphertext + auth tag n+16B)`. The `keyVersion`
prefix enables background key rotation without a full-table cutover. IV is freshly
generated per encryption call via `crypto.getRandomValues(new Uint8Array(12))`. A static or
deterministic IV is an explicit antipattern — reuse breaks GCM authentication entirely.

**KMS integration.** In the current k3s/k8s environment, k3s encrypts Secrets at rest via
`EncryptionConfiguration`; the application reads keys from environment variables injected
by scoped k8s Secrets. The `ENCRYPTION_MASTER_KEY` is mounted only on database-adjacent
pods, never on API or worker pods. A `KMSClient` interface (`encrypt`, `decrypt`,
`rotateKey`) abstracts the backing implementation; an HSM-backed KMS is required for
staging and production.

**Package layout.** `packages/data` contains: `db/` (three connection pools, migration
runner), `crypto/` (AES-GCM, HKDF), `kms/` (client abstraction), `analytics/` (event
writer, pseudonymization, differential privacy), `audit/` (append-only writer). Types live
in `packages/core/types/data.ts`.

**Core interfaces.**

- `KMSClient`: `encrypt(plaintext, keyId)`, `decrypt(ciphertext, keyId)`, `rotateKey(keyId)`
- `FieldEncryptor`: `encryptField(value, table)`, `decryptField(ciphertext, table)`
- `AnalyticsEvent`: `{ type, payload, sessionPseudonym, eventId (UUIDv4), timestamp, signature }`
- `AuditEntry`: `{ action, actorId, actorKind (user|agent|system), entityType, entityId, timestamp, result (allowed|denied) }`
- `QueryFn<TParams, TResult>`: typed alias for parameterized query functions returning `Promise<TResult[]>`

**Analytics tier.** Events written to `*_analytics` via the `analytics_w` role (no read
path back to `*_app`). Idempotent writes use `INSERT ... ON CONFLICT (event_id) DO
NOTHING`. Events are signed with a session-derived HMAC key (`HKDF(salt=serverHmacSecret,
ikm=jti, info="analytics-signing", length=32)`). Session pseudonyms rotate per session;
the pseudonym-to-user mapping lives only in `*_app` and is never exported. Laplace noise
and epsilon budget tracking are ~120 lines of DIY code — no external DP library.

**Schema migration.** Migration files live in `packages/db/migrations/NNN_description.ts`
and export `id`, `preCheck(sql)`, `up(sql)`, and `postCheck(sql)`. Every file opens with
a five-checkbox compatibility block. `migrator.ts` is a standalone program (never imported
by the app server) that runs migrations in numeric order, records each successful run in
`schema_migrations`, and exits non-zero on any failure. A failed `postCheck` is not
recorded — it can be retried after a fix.

---

## Application to market-alert PRD/plan

### PRD §5: Core Workflows

The seven-step alert workflow (detection → enrichment → dedup → delivery → acknowledgement
→ execution → replay) maps directly onto the three-store architecture:

- **Detection and ingestion** (step 1): EDGAR polling workers write raw filing data to
  `mkt_app` through a scoped internal API endpoint. Filing text is field-level encrypted at
  the point of write. The worker has no direct database credentials.
- **Enrichment and dedup** (steps 2–3): Enrichment workers fetch `CorporateAction.filing_text`
  via `GET /internal/corporate-actions/:id`, process it in-process, and write the enriched
  `Alert` back through `POST /internal/alerts`. Every enrichment decision and dedup merge is
  a business journal entry for replay.
- **Delivery** (step 4): `ALERT_NOTIFY` task triggers multi-channel delivery. The analytics
  tier in `mkt_analytics` receives a pseudonymized delivery event — never the raw alert
  content.
- **Acknowledgement and execution** (steps 5–6): Trader writes to `mkt_app` through
  authenticated API. Trade entity transitions are journal entries.
- **Replay** (step 7): Full event history reconstructed from the business journal, not from
  the transactional table's current state.

Edge cases addressed by the data layer:

- **Duplicate events from multiple sources**: Dedup key `(ticker, event_type, announced_at ± 24h)` with idempotency on `accession_number`. Dedup decisions are journaled and reversible.
- **Out-of-order arrivals**: `CorporateAction` uses earliest `filed_at` as `announced_at`; later authoritative dates update `effective_date`. Post-delivery amended filings emit `ALERT_SUPPLEMENT` tasks.
- **Messy SEC filings**: Raw filing text stored encrypted in the append-only raw filing store alongside the normalized entity; replayable for re-extraction.

### PRD §6: Entity Lifecycle

**Alert** (`Pending → Detected → Enriched → Deduplicated → Delivered → Acknowledged → Archived`):
Every state transition is a business journal entry. The journal stores the accepted
transition fact and links any compensation to the reversed transition. The graph entity
stores current state; the journal stores the transition history. Reversion produces a
compensation event. Alerts with `extraction_confidence: failed` still advance — they are
never silently dropped.

**Corporate Action** (`Announced → Effective → Closed → Disputed`):
Cron inserts `CORP_ACTION_ADVANCE` tasks on `effective_date` and `settlement_date`. The
scheduler worker calls `PATCH /internal/corporate-actions/:id/advance`. Admin-forced
`→ Disputed` transitions write a journal compensation event. Every field on the
`CorporateAction` entity that references real parties (ticker, CIK, filing text) is
field-level encrypted. The `retention_class` and `legal_hold` fields are set at ingestion
and govern automated deletion.

**Trade** (`Proposed → Executed → Settled → Reconciled`):
Trade entity fields for executed price and notional value are field-level encrypted (they
are financial data requiring protection against DB credential compromise). `alert_id` FK
links each trade to its originating alert for replay. Reconciliation records are
append-only. Settlement is driven by a `TRADE_SETTLE` task inserted by the scheduler worker
on `settlement_date`. RLS ensures each Trader sees only their own trades; Admin sees
aggregate views via `mkt_analytics`, not per-trader detail from `mkt_app`.

### PRD §7: Integration Needs

**Real-time market data feeds**: EDGAR ATOM feed is the v1 source; future vendor adapters
sit behind feature flags in the `feature_flags` table. Each vendor adapter records HTTP
fixtures for MSW v2 interception in CI — no live calls in tests. Egress for ingestion
workers is restricted to `www.sec.gov` and `efts.sec.gov` only.

**Data enrichment**: Filing text arrives in-hand from Phase 2; the enrichment worker reads
it from `mkt_app` through the internal API, never directly. Terms extraction writes a
structured `DealTerms` sub-entity. Delta-neutral impact calculation writes to the alert
entity. All enrichment output referencing real parties is field-encrypted.

**Outbound alerting**: Alert delivery events (not content) are written to `mkt_analytics`
as pseudonymized, session-attributed records. Channel failures (email, SMS, webhook) are
non-blocking; each is an audit event. The audit entry is written before the delivery
attempt.

**Event streaming and replay**: The business journal (in `mkt_app`) is the replay
substrate. `GET /api/replay/corporate-actions/:id` and `/api/replay/trades/:id` return
ordered journal entries. Point-in-time queries use `?at=<ISO8601>` to reconstruct
intermediate state. The analytics tier materializes pseudonymized session events and
aggregated metrics for cross-desk queries; it is populated from journal events, not from
direct `mkt_app` reads.

### Plan phases — data layer touchpoints

| Phase | Data layer work                                                                                                                                                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Schema scaffold (property graph tables, task queue views, feature_flags table). Three-layer migration model established. Structured logger + PII scrub layer.                                                                                                                                                                           |
| 1     | Four-pool Postgres (`mkt_app`, `mkt_audit`, `mkt_analytics`, `mkt_dictionary`) with disjoint roles and KMS key domains. Field-level AES-256-GCM encryption for sensitive entity types. Audit store (append-only, hash-chained, INSERT-only role). Business journal (distinct from audit log). RLS policies. HSM-backed KMS for staging. |
| 2     | `CorporateAction` entity type seeded in `entity_types` registry with `filing_text` marked sensitive. Raw filing store (append-only). EDGAR fixture recorded; MSW v2 handler wired. `accession_number` idempotency.                                                                                                                      |
| 3     | `Alert` entity type seeded. Deduplication engine writing journal entries. `DealTerms` sub-entity. `extraction_confidence` flag. Out-of-order event handling logic. Enrichment digital twin sandbox (`DATA-D-011`).                                                                                                                      |
| 4     | Analytics event pipeline activated. `mkt_analytics` receives pseudonymized delivery events. Audit events for channel failures. Trade entity type seeded (stub).                                                                                                                                                                         |
| 5     | `mkt_analytics` aggregated views for system health metrics (source ingestion rate, enrichment queue depth). Differential privacy on all analytics exports. Audit trail read endpoint.                                                                                                                                                   |
| 6     | Trade entity with encrypted price and notional fields. Reconciliation records (append-only). `TRADE_SETTLE` task settlement path. Business journal entries for all trade state transitions.                                                                                                                                             |
| 7     | Full analytics tier population. Session pseudonym rotation verified. Replay API. Point-in-time state query. Structured export (itself an audit event). 30-day fixture refresh.                                                                                                                                                          |

---

## Recommended technologies and vendors

**DB engine + version**: PostgreSQL 16. The blueprint mandates PostgreSQL across all stores;
version 16 is the current stable release with improved JSONB performance and logical
replication features needed for audit cold-storage replication.

**ORM/query builder**: None — `postgres` npm package with tagged template literals
(`IMPL-DATA-033`, `IMPL-DATA-035`). The property graph model does not benefit from an ORM's
schema file; tagged templates enforce parameterization structurally.

**Migration tool**: Custom `migrator.ts` implementing the blueprint's three-layer model
(`DATA-D-013`, `DATA-D-014`). Migration files in `packages/db/migrations/NNN_description.ts`
with mandatory `preCheck`, `up`, `postCheck`, and a five-checkbox compatibility block.
No external migration framework (Flyway, Liquibase, node-pg-migrate) — these do not support
the three-layer lifecycle separation the blueprint requires.

**Time-partitioning strategy**: PostgreSQL declarative range partitioning on `announced_at`
for `CorporateAction` entities and on `created_at` for the audit log and business journal.
Monthly partitions. Partition pruning keeps query latency stable as tables grow; partition
drop is the retention enforcement mechanism (no `DELETE` scans needed for aged data).

**Replay storage (event log / business journal)**: Dedicated `journal_entries` table in
`mkt_app` with columns: `id`, `entity_type`, `entity_id`, `event_type`, `payload JSONB`,
`actor_id`, `actor_kind`, `prev_hash`, `created_at`. The `prev_hash` column creates a
hash chain verifying append-only ordering. This is a dedicated relational table, not part
of the property graph, as permitted by `DATA-P-003` for integrity-critical infrastructure.
Partitioned by month on `created_at`. For compliance export, journal entries are streamed
to append-only cold storage (S3-compatible object store with Object Lock) via a background
job in Phase 7.

**Object storage for SEC filings**: S3-compatible object store (AWS S3 or MinIO for dev)
with Object Lock (WORM mode) for the raw filing text archive. Each filing stored as
`filings/<accession_number>/<form_type>.xml.enc` — AES-256-GCM encrypted before upload,
encrypted envelope format matching `IMPL-DATA-013`. The `CorporateAction` entity stores
only the storage key reference; the plaintext filing text is never stored unencrypted on
disk. MinIO in k3d for local development; AWS S3 with WORM Object Lock in staging and
production.

**Schema validation library**: Ajv (JSON Schema validator) v8 for application-layer
validation against the JSON Schema stored in `entity_types`. Ajv is the de facto standard
for JSON Schema draft-07/2019-09 validation in Node.js; it compiles schemas to optimized
validator functions, which is important for the per-write validation the property graph
model requires. No ORM-level schema enforcement — validation runs in `packages/data` before
the SQL write.

---

## Gaps and conflicts

**PRD §9 "minimal audit logging for MVP" is directly blocked.** The blueprint requires a
fully isolated audit store from the first commit that touches customer or market data. The
plan correctly overrides the PRD and treats comprehensive audit as a Phase 1 gate. There is
no residual gap here — it is resolved — but architects should flag this to product so the
PRD is not used as a reference for audit scope.

**Four-pool naming diverges from blueprint template.** The blueprint template uses
`superfield_app`, `superfield_analytics`, `superfield_audit`. The plan uses `mkt_app`,
`mkt_audit`, `mkt_analytics`, `mkt_dictionary`. The `mkt_dictionary` pool (trader identity
tokens under its own role) has no direct blueprint precedent. It must be treated with the
same disjoint-role, disjoint-KMS-key-domain requirements as the other pools, and its
inclusion should be confirmed against the AUTH blueprint's credential storage model to
avoid redundant or conflicting identity stores.

**Analytics tier is empty through Phase 6.** The plan defers `mkt_analytics` population
to Phase 7. During Phases 1–6, the Admin health dashboard (Phase 5) reads from
`mkt_analytics` for per-source metrics, but the analytics tier is not yet populated.
Either the health metrics must be sourced differently in Phase 5 (e.g., from `mkt_app`
task queue views via a read-only role that is not `app_rw`) or analytics population must
be pulled forward to Phase 4. Sourcing health metrics directly from `mkt_app` risks
violating `DATA-X-003` (analytics on transactional store).

**Differential privacy budget tracking location.** The blueprint stores the epsilon
budget counter in `mkt_app` (superfield_app). With the separate `mkt_analytics` database,
it is ambiguous whether budget state lives in `mkt_app` or `mkt_analytics`. It should live
in `mkt_analytics` alongside the data it governs, but this requires the `analytics_w` role
to have UPDATE privilege on a budget table — a more permissive grant than INSERT-only.
Alternatively, budget tracking lives in `mkt_app` under `app_rw`, but then the analytics
export path requires a cross-pool query, which the blueprint explicitly prohibits as an
architecture antipattern. This must be resolved before Phase 7.

**Digital twin sandbox (`DATA-D-011`) is specified for Phase 3 enrichment workers but not
fully designed.** The plan references digital twins for enrichment sandbox promotion
(`DATA-D-011`, `WORKER-D-006`, `WORKER-C-011/012`) but does not specify how twin state is
cloned from `mkt_app`, what credentials the twin uses, or how teardown is triggered. The
blueprint requires twin creation and teardown speed to be product requirements; the plan
leaves this as an implementation detail.

**Retention automation is unscheduled.** `DATA-C-033` (data retention automation) appears
nowhere in the phase plan. `CorporateAction` entities have a `retention_class` field, but
the automated deletion job that reads it is not assigned to any phase. This is a gap
against the DATA blueprint's data minimization requirement.

---

## Open questions

1. **`mkt_dictionary` pool scope**: What entity types live in `mkt_dictionary`, and does it
   duplicate or complement the AUTH blueprint's credential storage? If trader identity
   tokens are passkey credentials, they may already be governed by the AUTH blueprint's
   storage model; a separate pool adds complexity without clear isolation benefit unless
   the threat model is distinct.

2. **Analytics tier health metrics (Phase 5)**: Can per-source ingestion health metrics be
   served from `mkt_analytics` in Phase 5, or must analytics population be pulled forward
   from Phase 7? If the latter, what is the minimal analytics write path needed in Phase 4
   or 5?

3. **Differential privacy budget placement**: Should epsilon budget state live in
   `mkt_analytics` (near the data it governs, requiring broader analytics_w privileges) or
   in `mkt_app` (under app_rw, requiring a controlled cross-pool read in the export path)?
   A concrete decision is needed before Phase 7 analytics population begins.

4. **SEC filing object storage for local development**: MinIO is proposed for k3d dev. Does
   the k3d cluster topology in Phase 0 include a MinIO pod, or is object storage access
   stubbed in dev until Phase 2? Filing text encryption and storage must be exercised in
   integration tests before the Phase 2 exit criterion is met.

5. **Deduplication journal compensation**: When a dedup merge is reversed (two alerts
   un-merged), how is the compensation event structured in the business journal? The plan
   specifies that dedup decisions are journaled and reversible but does not specify the
   compensation schema. This must be defined before Phase 3 exits.

6. **Retention automation phase assignment**: Which phase owns the automated deletion job
   that reads `retention_class` and `legal_hold` on `CorporateAction` and `Trade` entities
   and deletes expired rows? This is a blueprint requirement (`DATA-C-033`) with no current
   phase assignment.

7. **Key rotation schedule**: The plan specifies "key rotation ≤ 90 days" but does not
   specify which entity types rotate on which schedule, or whether the rotation background
   job is a dedicated k8s CronJob or an enrichment worker sub-task. The `DATA-C-024`
   checklist requires automated rotation to be verified under load before Phase 1 exits.

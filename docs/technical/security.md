# Security Architecture

<!-- last-edited: 2026-04-10 -->

This document covers the security decisions for the autolearning knowledge base,
with particular attention to customer data protection, encryption, and access control.

---

## Threat Model

The system holds sensitive customer data: emails, meeting transcripts, CRM records,
and synthesised wiki pages. The primary threats are:

1. **Unauthorised cross-RM access** — one relationship manager reading another's
   customer data.
2. **Unauthorised cross-department access** — one department's worker or user
   reading another department's data.
3. **Data breach at rest** — a compromised storage volume exposing customer data.
4. **Data breach at the database layer** — a compromised Postgres session with an
   overly-privileged role.
5. **Embedding inversion** — an adversary with access to stored vectors partially
   reconstructing the source text.
6. **Worker over-reach** — an ephemeral worker pod reading data outside its assigned
   (department, customer) scope.

---

## Anonymisation Layer

Ground-truth data (email bodies, transcript text) is anonymised at ingestion time,
before any worker or agent reads it. PII is replaced with stable tokens
(e.g., `CUST_7f3a`, `ORG_12bc`).

The `IdentityDictionary` table maps tokens to real identities and is stored
separately, encrypted, and access-controlled independently of the corpus tables.

**What anonymisation does and does not protect:**

- Protects against direct PII exposure in the text corpus.
- Does not protect against semantic inference — a reader can still derive that
  "CUST_7f3a is interested in restructuring their bond portfolio" from the
  anonymised text.
- Does not protect the vector embeddings, which encode semantic content regardless
  of token substitution (see below).

---

## Vector Embedding Encryption

### The concern

Vector embeddings are not safe to leave unprotected even when the source text is
anonymised. Embeddings encode semantic meaning as float arrays. An adversary with
access to the embedding model can partially invert a vector by:

1. Generating candidate texts.
2. Embedding them with the same model.
3. Finding the closest match to the target vector.

This is not full inversion, but it is sufficient to reconstruct the gist of a chunk
— particularly for short, structured text such as email subjects or CRM notes. The
anonymisation tokens do not help here because semantic content survives tokenisation.

A secondary concern: if column-level encryption covers text chunks but not the
`vector` column, the embeddings sit unencrypted alongside encrypted text, partially
defeating the encryption.

### Why column-level encryption is not viable for vectors

Encrypting the `vector` column with `pgcrypto` or application-layer encryption breaks
pgvector indexing. HNSW and IVFFlat indexes operate on raw float values. Encrypted
columns cannot be indexed by pgvector, which means similarity search requires
decrypting every vector for every query — impractical at any meaningful corpus size.

### Decision: full-disk encryption at the storage layer

Postgres data volumes are encrypted at the storage layer in Kubernetes (encrypted
PersistentVolumes). This provides:

- Vectors encrypted on disk with no query-time penalty.
- No pgvector index limitations.
- Protection against a compromised storage volume or physical media.

**Residual risk:** A compromised Postgres session with sufficient role privileges
can still read vectors. This is mitigated by RLS (see below) and by scoping
database roles to the minimum necessary access. It is a database breach scenario,
not a vector-specific one.

### Embedding model containment

The embedding service (Ollama in development; in-house Rust server in production)
runs inside the Kubernetes cluster and is not exposed externally. Text sent for
embedding never leaves the cluster boundary. This eliminates the external inversion
risk — an adversary would need cluster access to reach either the embedding service
or the stored vectors.

---

## Row-Level Security (RLS)

All customer data tables enforce RLS at the Postgres layer. RLS is not an
application-layer check — it is enforced by the database for every query regardless
of how the connection is made.

### Human users

| Role                 | Data visible                                          |
| -------------------- | ----------------------------------------------------- |
| Relationship Manager | Only rows where `customer.assigned_rm = current_user` |
| Department Admin     | All rows within their department                      |
| Global Admin         | All rows                                              |

### Worker pods

Ephemeral worker pods are issued Kubernetes service account credentials scoped to
a specific (department, customer) pair at launch time. The corresponding Postgres
role is bound by RLS to that scope. A worker for Department A / Customer X cannot
query Department B or Customer Y's rows — enforced at the database layer.

### IdentityDictionary

The dictionary table has a separate RLS policy. Access is granted only to roles
with `can_view_dictionary = true`. Relationship Managers do not hold this privilege
by default; re-identification for display is performed at the API layer by a
dedicated service that holds dictionary access, not by passing dictionary privileges
to the RM's session.

---

## Encryption at Rest: Scope

| Data                                          | Encryption mechanism                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Ground-truth text (emails, transcripts)       | Postgres full-disk encryption + column-level encryption via `pgcrypto` for highest-sensitivity fields |
| Vector embeddings                             | Postgres full-disk encryption (column-level not viable with pgvector)                                 |
| Wiki pages                                    | Postgres full-disk encryption                                                                         |
| IdentityDictionary                            | Postgres full-disk encryption + column-level encryption on all identity fields                        |
| Audio recordings (file store)                 | Encrypted PersistentVolume or object storage with server-side encryption                              |
| Kubernetes secrets (DB credentials, API keys) | Kubernetes Secrets encrypted at rest via provider KMS                                                 |

---

## Encryption in Transit

- All external traffic (PWA → API, AssemblyAI webhook, IMAP client) over TLS 1.2+.
- All cluster-internal pod-to-pod traffic traverses a Linkerd mTLS proxy sidecar.
  Every call between meshed pods is encrypted end-to-end with a SPIFFE-style identity
  certificate issued by the Linkerd identity controller. A workload without a valid
  mesh identity cannot reach any other service in the cluster (default-deny
  AuthorizationPolicy per namespace — see `k8s/linkerd/authorization-policies.yaml`).
- Postgres connections from application pods require SSL (`sslmode=require`).

### Linkerd mTLS implementation details

**Why Linkerd:** Linkerd uses eBPF-free, Rust-based micro-proxies injected as
sidecars. It adds mTLS with zero application-code changes and supports distroless
workload images (the sidecar uses its own init container for iptables rules; no
shell in the workload container is required).

**Namespace injection:** The three application namespaces (`superfield-server`,
`superfield-web`, `superfield-worker`) carry `linkerd.io/inject: enabled`. Every pod
created in these namespaces receives a Linkerd proxy sidecar automatically unless
explicitly opted out.

**Default-deny posture:** Each namespace has a `Server` resource describing the
protected port(s) and an `AuthorizationPolicy` that grants access only to workloads
presenting a valid `MeshTLSAuthentication` identity. Non-meshed callers (pods
without a valid SPIFFE certificate) are denied at the mesh layer.

**Upgrade path:** `k8s/linkerd/upgrade.sh` performs a rolling sidecar version
upgrade with zero downtime. The script applies CRD updates, upgrades the control
plane, then performs a `kubectl rollout restart` for each deployment in the meshed
namespaces — replacing old sidecars one pod at a time. `linkerd check` runs at
the end to verify the upgraded state.

---

## Worker Credential Lifecycle

Worker pods are ephemeral and triggered either by a new document ingestion event or
by the gardening cron. Credentials follow the pod lifecycle:

1. Kubernetes creates the pod with a scoped service account.
2. The service account is bound to a Postgres role limited by RLS to
   (department, customer).
3. The pod completes its work and terminates.
4. The service account token expires; no long-lived credential persists.

Worker pods have read-only access to ground-truth tables and read-write access to
synthetic tables (wiki pages, customer interests) within their scope only.

---

## Open Questions

- **KMS provider:** Confirm which KMS is used for Kubernetes Secret encryption
  (cloud provider KMS or self-hosted).
- **Audit logging:** Define which operations (dictionary access, cross-department
  queries attempted, wiki mutations) require an audit trail and where logs are stored.
- **Penetration testing scope:** Define before first external user access.

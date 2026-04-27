# Architecture

## Overview

`finance-kb` uses PostgreSQL as the system of record for both transactional
application data and retrieval-oriented knowledge structures.

The goal is to get the best of both worlds:

- a property-graph model for explicit entities, typed relationships, versioned
  lineage, and auditable traversal
- vector embeddings for broad semantic recall over text-heavy content
- JSONB for lossless, parser-native document structure that does not fit neatly
  into a small fixed relational schema

This is not a pure "graph DB" design and not a pure "vector DB" design.
It is a hybrid Postgres architecture where graph, vector, and document layers
coexist in one operational model.

## Design Goal

The database must support four distinct behaviors at the same time:

1. transactional application writes for the product's operational workflows
2. graph-style traversal across customers, meetings, emails, wiki drafts,
   document blocks, facts, and typed links
3. vector similarity search over chunks, blocks, and synthesized facts
4. provenance-preserving document reconstruction for review, compliance, and
   AI wiki synthesis

The central design principle is:

> use vectors to find, and graph structure to prove

Vector retrieval is used for semantic candidate generation. Typed graph links,
version lineage, and source provenance are used to validate, expand, and explain
the retrieved material.

## Why Postgres

Postgres gives us the practical properties we need:

- transactional integrity for operational workflows
- JSONB for rich parser output and source-specific metadata
- relational structure for entities, versions, and typed links
- `pgvector` for ANN-style semantic retrieval
- full-text search where sparse keyword matching is better than embedding-only
  retrieval
- optional graph-query optimization through extensions such as Apache AGE if we
  need a richer traversal model than recursive CTEs alone

Postgres is also operationally attractive:

- mature HA, replication, backup, and failover patterns
- strong throughput under mixed transactional and retrieval-heavy workloads
- broad support across managed cloud vendors
- a large ecosystem of tools and operators compared to specialized graph
  databases

This avoids splitting the product too early across a separate vector store, a
separate graph store, and a document metadata store.

## Architecture Layers

Documents are represented in three primary layers.

### 1. Source Blob Layer

This is the raw source of truth for an ingested artifact.

Examples:

- uploaded PDF
- DOCX file
- email MIME payload
- transcript JSON payload
- CSV/XLSX export
- CRM export snapshot

This layer preserves the exact original payload, checksum, source type, ingest
time, ownership, and version identity. It is the audit anchor. We should always
be able to answer: "what original thing did this derived knowledge come from?"

Typical fields:

- `source_document_id`
- `source_version_id`
- `blob_ref` or object-store pointer
- `mime_type`
- `content_hash`
- `source_system`
- `ingested_at`
- `tenant_id`

### 2. Lossless JSON Block Layer

Every parser emits a canonical intermediate representation as JSON.

This is the normalized document model. It is parser-agnostic enough to unify
multiple file types, but lossless enough to preserve the structure needed for
review, re-parsing, citation, and downstream extraction.

Examples of block types:

- heading
- paragraph
- list item
- table
- table row
- table cell
- email header
- email body fragment
- transcript segment
- quote block
- metric row

Typical block attributes:

- stable block identifier
- block type
- plain text
- order within the source version
- parent/child structural relationships
- format-specific metadata in `meta`

Typical `meta` examples:

- page number
- bounding box
- heading level
- table coordinates
- speaker label
- timestamp range
- source field path
- sheet name
- original style name

This layer is the canonical parsing substrate. It is the right place to store
the output of `Docling` or another parser before projecting pieces into more
specialized tables.

### 3. Vector Embedding Layer

Selected textual units from the block layer are embedded for semantic retrieval.

These may include:

- full blocks
- merged structural sections
- extracted semantic facts
- wiki draft sections

Embeddings are not the canonical document representation. They are an index over
selected textual views of the underlying content.

This distinction matters:

- the source blob preserves the original artifact
- the JSON block layer preserves interpretable structure
- the embedding layer enables semantic access

## Property Graph Model

The application already uses a Postgres property graph shape:

- `entities` hold typed nodes
- `relations` hold typed edges
- `properties JSONB` preserves flexible metadata

That model should remain the core graph abstraction for business objects and
cross-object relationships.

Examples of entity classes:

- customer
- user
- transcript
- email
- corpus_chunk
- wiki_page
- wiki_page_version
- source_document
- source_version
- source_block
- semantic_fact

Examples of relation types:

- `manages`
- `mentions`
- `derived_from`
- `part_of`
- `version_of`
- `same_thread`
- `supports`
- `contradicts`
- `about_customer`
- `discussed_in`

The graph layer is where we preserve explicit meaning that embeddings alone
cannot reliably encode:

- multi-hop relationships
- temporal changes
- disambiguated entities
- negation and contradiction
- structural containment
- provenance paths

## Hybrid Retrieval Model

We should not choose between VectorRAG and GraphRAG. The system should combine
them.

### Vector Phase

Use embeddings to retrieve broad semantic candidates quickly:

- similar blocks
- similar facts
- prior wiki sections
- related meetings, emails, or reports

This phase optimizes recall.

### Graph Phase

Use graph traversal to validate and enrich the vector candidates:

- traverse to the source version
- resolve customer/entity context
- expand to supporting or contradictory blocks
- follow thread, section, or version lineage
- verify typed links before synthesis

This phase optimizes precision, explainability, and multi-hop reasoning.

### Synthesis Phase

Generate wiki output from validated blocks and facts, not from anonymous chunks.

Every synthesized claim should be backed by:

- one or more source blocks
- a source document/version identity
- an explicit provenance path
- a confidence or review state where appropriate

## Why This Beats the False Choice

The "VectorDB vs GraphDB" debate is often framed too broadly.

At internet or population scale, graph-heavy workloads often mean very large,
high-fanout traversal problems:

- fraud rings across millions of accounts
- ownership and control chains across corporate populations
- supply-chain dependency mapping across large vendor networks
- security graph traversal across machines, identities, and permissions

Those workloads justify specialized graph-first infrastructure because deep
multi-hop traversal across millions or billions of nodes is the product itself.

That is not the primary shape of `finance-kb`.

Our main workload is document intelligence:

- finding the right evidence block
- preserving section and thread structure
- connecting facts to sources
- assembling narratives from related notes, meetings, emails, and reports
- tracing revisions across versions

These are still graph problems, but they are not usually "find a six-hop fraud
ring in a population graph" problems.

The graph value here is different:

- explicit containment
- explicit provenance
- explicit version lineage
- explicit support and contradiction
- explicit entity grounding

In other words, we use graph structure to make document relationships legible,
not to optimize for extreme social-network-style traversal depth.

That is why a Postgres-centered hybrid design is the right fit.

### What Vectors Are Good At

Vector search is excellent for:

- broad semantic recall
- fuzzy matching across paraphrases
- recovering relevant text without exact keyword overlap
- cheap first-pass search over large text corpora

If a user asks for "customer anxiety around Q3 rollout risk", vector retrieval
is the fastest way to surface candidate transcript segments, emails, notes, and
draft wiki sections that may express that idea in different language.

### What Graph Primitives Are Good At

Graph primitives are excellent for:

- preserving document hierarchy
- connecting a block to its source document and source version
- relating extracted facts back to evidence
- representing support, contradiction, and derivation
- disambiguating entities using explicit context
- building navigable narratives rather than flat search results

If a retrieved block says a customer is "not ready to expand budget", vector
similarity alone cannot safely preserve all of the important structure:

- who said it
- in what meeting
- whether it was later contradicted
- whether it belongs to the same thread as a follow-up email
- whether it superseded an earlier version of a summary

That is what the graph layer is for.

### Why Triples Still Matter

Even if we do not need fraud-detection-style traversal depth, triples are still
the right primitive for organizing knowledge.

Examples:

- `block -> part_of -> source_version`
- `source_version -> version_of -> source_document`
- `semantic_fact -> derived_from -> block`
- `block -> mentions -> customer`
- `block -> supports -> semantic_fact`
- `block -> contradicts -> block`
- `wiki_section -> cites -> block`

These triples are useful because they turn raw text into searchable structure.
They let us:

- rebuild document hierarchies
- walk from summaries to evidence
- construct narrative chains
- explain why a synthesis was produced
- keep retrieval grounded in source material

This is enough graph structure to materially improve search and synthesis,
without requiring us to bet the system on very deep graph traversal as the core
query pattern.

### Why We Avoid a Pure GraphDB Posture

A pure graph-first design would over-optimize for traversal patterns that are
not dominant in this product.

It would push us toward:

- early ontology over-design
- more operational complexity
- premature specialization around deep-path traversal
- weaker first-pass semantic recall unless paired with vector infrastructure

For `finance-kb`, that is the wrong center of gravity.

### Why We Avoid a Pure VectorDB Posture

A pure vector-first design would flatten exactly the information we most need to
trust the wiki layer:

- hierarchy
- authorship and source identity
- revision lineage
- typed support and contradiction
- citation paths

It would be good at "find similar text" and weak at "show why this statement is
true, what it depends on, and how it changed."

### The Practical Synthesis

This architecture gets the best properties of both sides:

- vector retrieval gives high-recall candidate search over large corpora
- graph triples preserve explicit structure and provenance
- Postgres keeps both in one transactional model
- JSONB preserves parser fidelity without forcing premature rigid schemas

So the answer to the debate is not:

- "GraphDB is better than VectorDB"
- or "VectorDB makes graphs unnecessary"

The answer is:

> document systems need vector search for recall and graph primitives for
> structure, provenance, and narrative assembly

That is why this design is intentionally hybrid.

## Versioning and Incremental Updates

One of the main reasons to keep an explicit graph/document model is update
efficiency.

Vector-only systems tend to push toward full or broad re-embedding when source
documents change. Our design should instead support incremental updates:

- new source version arrives
- parser emits normalized blocks
- unchanged blocks are reused where possible
- only changed or new blocks are re-embedded
- semantic links are updated at block and fact granularity
- prior versions remain queryable

This is especially important for:

- revised customer reports
- evolving email threads
- meeting follow-ups
- compliance-sensitive edits to wiki drafts

## Recommended Storage Shape

At a conceptual level, the knowledge-bearing schema should evolve toward these
primitives:

- `source_documents`
- `source_versions`
- `source_blocks`
- `semantic_facts`
- `semantic_links`

The existing `entities` and `relations` tables remain useful as the general
property-graph substrate. The document-specific tables give us better control
over retrieval-heavy data, version lineage, and parser output fidelity.

In practice:

- raw source metadata belongs with source document/version records
- normalized parser output belongs in JSONB-backed block records
- embeddings belong on retrieval-oriented text units
- typed relations belong in graph-native structures

## Parser Strategy

The preferred ingestion flow is:

`source file -> parser -> normalized document JSON -> projected blocks/facts -> embeddings + links`

For rich documents, `Docling` is the preferred primary parser because it can
emit a lossless, structured representation that maps naturally into the block
layer.

The database should never depend directly on parser-specific object models.
Parser output must be normalized before persistence.

### Confidence-Based Parsing

The parser layer should not be treated as a single-tool commitment. It should be
confidence-driven.

The default path is:

- parse with `Docling`
- score parser confidence
- accept the parse when structure and text quality are high enough
- route low-confidence documents to a fallback path

This gives us a practical operating model:

- common documents stay on the open-source local path
- difficult documents use a more expensive fallback only when needed

### Primary Path: Docling

`Docling` should be the first parser for documents that it can interpret with
high confidence.

Typical examples:

- standard PDFs with a usable text layer
- DOCX documents
- structured reports with recoverable headings and tables
- documents where layout reconstruction is stable

If `Docling` returns sufficiently strong structure, text fidelity, and layout
signals, we keep its result as the canonical normalized parse.

### Fallback Path: Low-Confidence Documents

Some documents will not parse reliably through the primary path.

Examples:

- complex-layout PDFs
- scanned PDFs
- bitmap-heavy pages
- image-based reports
- tables or diagrams that collapse under local parsing

For these, we need a second-stage parsing path that can produce a stronger
layout-aware result.

The key invariant is:

> fallback parsers must return data that can be normalized into the same
> canonical lossless JSON document model as `Docling`

The rest of the system should not need to care which parser produced the
normalized output.

### Fallback Option A: Hosted Unstructured

One fallback option is a hosted `Unstructured` account accessed over API.

This is appropriate when:

- the document is hard enough that local parsing confidence is low
- paying for a premium parsing path is justified
- we want a managed service for exceptional documents rather than standing up
  more local infrastructure

The trade-off is that this is a closed-source external dependency and requires
careful handling of data-governance boundaries.

### Fallback Option B: Self-Hosted dots.ocr

Another fallback option is `dots.ocr`, likely deployed as a containerized
service.

This is appropriate when:

- we want an open-source fallback path
- we need stronger OCR/layout recovery than the primary parser can provide
- we want to avoid always sending difficult documents to a hosted third party

For a small volume of exceptional documents, CPU deployment may be acceptable.
For batch-heavy workloads or high-throughput OCR, GPU-backed inference will
likely be necessary.

### Architecture Implication

The ingestion architecture should treat parser selection as a routing problem,
not a schema problem.

We should persist:

- which parser was used
- parser version
- parser confidence
- fallback reason
- normalization warnings

This metadata belongs in document/version or block-level provenance fields.

### Required Experiments

We should explicitly evaluate both fallback strategies:

- premium hosted parsing via `Unstructured`
- open-source OCR fallback via `dots.ocr`

The experiment should measure:

- text fidelity
- layout fidelity
- table recovery
- normalization effort into the canonical JSON model
- latency
- operational cost
- privacy and compliance fit

The goal is not to declare a universal winner in advance. The goal is to decide
which fallback path is best for `finance-kb`'s difficult-document slice.

## Explainability and Compliance

The architecture is designed so retrieval is inspectable.

For any generated wiki statement, we should be able to show:

- the source blocks used
- the source document and version
- the relationship path used to connect evidence
- whether the connection came from structure, extraction, or semantic similarity

This is necessary for:

- human review
- citation UX
- internal trust
- customer-facing auditability
- future compliance workflows

## Non-Goals

This architecture does not assume:

- a separate graph database is required on day one
- embeddings are sufficient as a standalone memory layer
- parser output should be reduced immediately to flat chunks
- ontology design must be fully complete before shipping useful retrieval

We start with a narrow, explicit schema for the highest-value document and
relationship types, then expand incrementally as the corpus and workflows
become more complex.

## Summary

`finance-kb` treats Postgres as a hybrid knowledge substrate:

- a property graph for explicit structure and traversal
- a vector index for semantic recall
- a JSONB-backed document store for lossless normalized parsing

Documents move through layered representations:

1. source blob
2. lossless normalized JSON blocks
3. vector embeddings over selected textual units

That layered model gives us better retrieval, better provenance, better update
behavior, and a stronger foundation for AI wiki synthesis than either a flat
vector store or a pure document graph alone.

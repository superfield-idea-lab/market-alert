# Embedding Strategy

<!-- last-edited: 2026-04-10 -->

This document records the embedding provider decision for the autolearning knowledge base
and the reasoning behind it.

---

## Context

The system ingests ground-truth customer data (emails, meeting transcripts) and
synthesises a customer wiki via a Claude-based autolearning agent. Embeddings are
used at two points:

1. **Ingestion** — each text chunk is embedded and stored in pgvector for retrieval.
2. **Query time** — a user question or agent prompt is embedded and compared against
   stored chunk vectors to find the most relevant context.

The generation model is Claude (Anthropic API). The embedding model is a separate
choice.

---

## On Matching Embedding Provider to Inference Provider

Embeddings and generation are independent steps. The embedding model produces a
vector; pgvector finds the nearest chunks; those chunks are passed as plain text to
Claude. Claude never sees the vectors — only the retrieved text. There is no
technical coupling between embedding provider and inference provider.

The claim that Voyage embeddings work better with Claude is a training-distribution
argument: "our embedding model was trained on similar data to Claude, so the semantic
space is more compatible." This may be marginally true but is not well-evidenced in
independent benchmarks. It is partly marketing positioning.

What actually determines retrieval quality:

- How well the embedding model handles your specific text types (long emails, meeting
  transcripts, wiki prose)
- Vector dimensionality and index configuration relative to corpus size
- Chunking strategy — this typically has more impact than which embedding model is used

The trade-off below applies regardless of which inference provider you use. The same
decision would be reached with GPT-4o or Gemini as the generation model.

---

## Voyage AI vs. Open Self-Hosted Models

### Where Voyage AI has a real advantage

**1. Managed service quality.**
Voyage is a well-maintained, high-quality embedding API with strong MTEB retrieval
scores. It requires no infrastructure investment and the model is kept up to date by
the provider.

**2. Retrieval benchmark quality.**
On standard MTEB (Massive Text Embedding Benchmark) retrieval tasks, `voyage-large-2`
and `voyage-3` consistently outperform `nomic-embed-text` and are competitive with
`mxbai-embed-large`. For a product where retrieval quality directly determines wiki
accuracy, this gap is meaningful.

**3. Domain-specific variants.**
Voyage offers `voyage-finance-2`, `voyage-law-2`, and `voyage-code-2`. If the customer
corpus is domain-concentrated (e.g., financial services CRM), a domain-tuned model
can materially improve recall without any fine-tuning effort.

**4. No infrastructure overhead.**
Voyage is an API call. No GPU or CPU memory budget, no container to maintain, no
model version management.

---

### Where open self-hosted models win for this product

**1. Data never leaves the cluster.**
This is the decisive factor here. Ground-truth data is sensitive customer information.
Even with the anonymisation layer (PII replaced by tokens), sending corpus chunks to
an external API:

- Creates an external data processor relationship with compliance and contractual
  implications.
- Means anonymised-but-linked text transits a third-party network on every ingestion
  and query.
- Adds a dependency on Voyage's uptime and data retention policies.

A self-hosted embedding model running inside the Kubernetes cluster means corpus
text never leaves the infrastructure boundary.

**2. No per-token cost at scale.**
A CRM knowledge base grows continuously. Every new email, transcript, and wiki
revision generates embedding calls. At volume, Voyage's per-token pricing becomes
a significant ongoing cost. A self-hosted model has fixed infrastructure cost only.

**3. No external API key to manage per worker.**
Worker containers are ephemeral and scoped to (department, customer). Injecting a
Voyage API key into every worker pod adds credential surface area. A shared internal
embedding service has one network endpoint and no secrets to distribute.

---

## Decision

**Use a self-hosted embedding model via Ollama, deployed as a shared internal
Kubernetes service.**

The data-boundary and cost arguments are decisive for this product. Sensitive customer
data should not transit an external API, regardless of the anonymisation layer.

The quality gap between Voyage and a good open model is real but narrower than it
was in 2023. For a well-scoped corporate CRM corpus in English, a mid-size open model
retrieves well enough that the Voyage quality advantage does not justify the trade-offs.

If retrieval quality becomes a measurable bottleneck after launch, a domain-fine-tuned
open model is the next step — not switching to a paid external provider.

---

## Selected Model

**`nomic-embed-text-v1.5`** (via Ollama, development; in-house Rust server, production)

| Property             | Value                                 |
| -------------------- | ------------------------------------- |
| Parameters           | 137M                                  |
| Disk size            | 274MB                                 |
| Dimensions           | 768 (Matryoshka: configurable 64–768) |
| Context window       | 8192 tokens                           |
| MTEB retrieval score | 62.39                                 |
| License              | Apache 2.0                            |

**Why nomic over mxbai-embed-large:**

`mxbai-embed-large` scores marginally higher on MTEB (64.68 vs 62.39) but has a
512-token context window. Emails and meeting transcripts routinely exceed 512 tokens;
aggressive chunking to fit that window loses cross-sentence context and degrades
retrieval quality on exactly the text types this product handles. `nomic-embed-text-v1.5`
handles 8192 tokens, is less than half the parameter count (137M vs 335M), and runs
faster on CPU.

The MTEB gap does not compensate for the context window mismatch.

---

## Architecture

### Development (Ollama)

```
Ingestion worker (ephemeral pod)
        |
        | HTTP POST /api/embed  (cluster-internal)
        v
Ollama service  [nomic-embed-text-v1.5]
        |
        | float[768] vector
        v
pgvector (Postgres)  — stored alongside anonymised chunk text
```

Ollama is used during development for fast iteration. It is a convenience wrapper
and is not the production target.

### Production (in-house Rust embedding server)

Ollama will be replaced by an in-house Rust HTTP service before production. The
internal API contract (POST /embed → float array) is kept identical so worker pods
require no changes at cutover.

**Implementation approach:**

- [`candle`](https://github.com/huggingface/candle) (Hugging Face's pure-Rust
  inference framework) as the inference backend — no C++ runtime dependency, direct
  model loading from HuggingFace format, actively maintained by HF alongside the
  nomic model family.
- Thin Axum HTTP server exposing `POST /embed` accepting `{ input: string[] }` and
  returning `{ embeddings: float[][] }`.
- Deployed as a shared Kubernetes Deployment (not per-worker) — stateless, no
  customer scoping needed.
- CPU-optimised build with BLAS acceleration (`candle` supports OpenBLAS/Intel MKL
  via feature flags).

**Why candle over ort (ONNX Runtime):**

`ort` offers better CPU optimisation via Intel MKL but adds a C++ runtime dependency
and requires exporting the model to ONNX format first. `candle` loads HuggingFace
model weights directly, is pure Rust, and is the path of least friction for a team
already working in Rust. If CPU throughput becomes a bottleneck post-launch, migrating
the inference backend to `ort` is a contained change behind the same HTTP interface.

---

## Revisiting This Decision

Reconsider Voyage AI if:

- Retrieval quality is measurably degrading wiki accuracy after launch and a
  domain-fine-tuned open model does not close the gap.
- The anonymisation layer is independently certified to fully satisfy data-processor
  compliance requirements, removing the data-boundary concern.

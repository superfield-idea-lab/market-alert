# Documentation

Product and engineering documentation for the autolearning knowledge base.

## Product

- [PRD](./PRD.md) — product requirements, user roles, workflows, state machines, open questions
- [Implementation plan v1](./implementation-plan-v1.md) — phase structure, scout gating, dependency ordering, and blueprint-rule mapping for the v1 build

## Technical

- [Embedding strategy](./technical/embedding.md) — provider decision, self-hosted Ollama rationale, pgvector integration
- [Security architecture](./technical/security.md) — encryption, RLS, vector embedding risk, worker credential lifecycle
- [Wiki editing architecture](./technical/md-file-editing.md) — how Claude CLI edits wiki content, Postgres schema, serving to PWA
- [Database architecture](./technical/db-architecture.md) — schema, roles, RLS, encryption, vectors, task queue, migrations
- [Running demo mode](./running-demo-mode.md) — k3d bootstrap, dev server startup, and local-vs-production lifecycle boundaries

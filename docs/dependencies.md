# Dependency decisions

Phase 0 deliverable (`ARCH-C-005`, `IMPL-ARCH-023`). Every runtime dependency must have a
Buy/DIY entry here. "Buy" means the functionality is not feasible to build and maintain at
small team scale. "DIY" entries explain why we built instead.

---

## Runtime dependencies

| Package                      | Decision        | Reason                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hono`                       | Buy             | Thin, type-first router with first-class Bun support, zero heavy transitive dependencies. DIY routing at this level adds no product value.                                                                                                                  |
| `postgres`                   | Buy             | Minimal, type-safe tagged-template PostgreSQL client. Keeps SQL readable in query plans; ORM abstraction rejected (see ADL).                                                                                                                                |
| `@simplewebauthn/server`     | Buy             | WebAuthn server logic is cryptographically complex and spec-revision-sensitive. Self-hosting is required (no SaaS custody); rewriting is not feasible at team size.                                                                                         |
| `zod`                        | Buy             | Runtime type validation at system boundaries. `z.infer<>` eliminates a second type definition; `z.parse()` is the runtime guard. Core to the type safety model.                                                                                             |
| `pino`                       | Buy             | Structured JSON logging with PII redaction and minimal overhead. Standard for Node/Bun production services.                                                                                                                                                 |
| `fast-xml-parser`            | Buy             | EDGAR RSS/Atom parsing. Pure JS, zero native dependencies. DIY XML parsing is error-prone and not a product differentiator.                                                                                                                                 |
| `cheerio`                    | Buy             | HTML extraction from SEC filing text. Proven, minimal, sufficient for the v1 regex extraction path.                                                                                                                                                         |
| `imapflow`                   | Buy             | IMAP client for email-feed ingestion (Phase 3+). Implements RFC-correct IMAP including UIDVALIDITY epoch handling; rewriting IMAP is not feasible.                                                                                                          |
| `TanStack Query v5`          | Buy             | stale-while-revalidate, background refetch, and `state-matrix.json` loading/empty/error/success states require non-trivial cache management. Rebuilding by hand would be substantial undifferentiated work. Most-maintained headless data-fetching library. |
| `TanStack Table v8`          | Buy             | Headless sort/filter/column-control primitives. The alert feed table has enough complexity (multi-column sort, client-side filter by event type/spread/date, column control) to justify the library over a hand-built table.                                |
| `@testcontainers/postgresql` | Buy (test only) | Provisions a real PostgreSQL 16 instance per test run. Required by the no-mocks testing rule; no feasible DIY alternative for real-database tests in CI.                                                                                                    |
| `msw` (v2)                   | Buy (test only) | MSW v2 intercepts at the transport layer so real `fetch()` executes in every test. The no-mocks rule prohibits `vi.mock`; MSW is the only compliant HTTP interception approach.                                                                             |
| `playwright`                 | Buy (test only) | Headless Chromium for E2E and component tests. The sub-second WebSocket latency assertion (merge gate) requires a real browser. No feasible DIY alternative.                                                                                                |

## Explicitly rejected dependencies

| Package                      | Decision                          | Reason                                                                                                                                 |
| ---------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma` / `drizzle`         | DIY (`postgres` tagged templates) | Blueprint data rule requires query-visible SQL. RLS integration is cleaner without ORM abstraction.                                    |
| `ajv`                        | Removed                           | Maintaining Zod + derived JSON Schema fed to Ajv is redundant. `z.parse()` covers all system-boundary validation needs.                |
| `redis` / `bullmq`           | DIY (Postgres SKIP LOCKED)        | Already implemented in `packages/db/task-queue.ts`; satisfies all task-queue blueprint rules; avoids adding a second stateful service. |
| `ws`                         | DIY (Bun native)                  | Bun's native `Bun.serve` WebSocket upgrade is sufficient and eliminates the dependency.                                                |
| `react-hook-form` / `formik` | DIY (`useState`)                  | Both forms in v1 (watchlist management, trade proposal) are simple enough not to warrant a library.                                    |
| `next.js`                    | DIY (Vite SPA)                    | Product is real-time WebSocket-driven; SSR adds no latency benefit. A second server boundary would split auth and WebSocket ownership. |
| `auth0` / `clerk`            | DIY (`@simplewebauthn/server`)    | Trading platform; no SaaS custody of credentials.                                                                                      |

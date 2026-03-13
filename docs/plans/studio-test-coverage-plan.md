# Studio Test Coverage Plan

## Goal

Bring the Studio feature up to major-feature quality with deliberate coverage in all four required suites:

- Unit
- Integration
- Component
- E2E

The current suite proves basic availability and one happy-path chat flow. It does not yet protect rollback, reset, multi-turn context, or failure handling. This plan closes those gaps.

## Coverage Standard

A Studio change is not complete unless it includes tests in the appropriate suite:

- Unit tests for pure parsing, prompt construction, and branching rules
- Integration tests for `/studio` endpoint contracts and server-side session behavior
- Component tests for `StudioChat` browser behavior in Chromium
- E2E tests for the operator-facing workflow through the full application

## Original Gaps

- No rollback test coverage
- No reset/session-clearing test coverage
- No multi-turn context test coverage
- No API failure-path coverage for `400` / `403` / subprocess failure
- No UI error-state coverage
- No coverage for commit-list refresh after rollback

## Current Status

Closed in this branch:

- unit coverage for Studio parsing, prompt construction, and validation helpers
- integration coverage for `/studio/status`, `/studio/chat`, `/studio/reset`, and `/studio/rollback`
- integration coverage for `bun run studio` bootstrap behavior on a pre-created `studio/session-*` branch and failure on invalid branches
- integration coverage for successful rollback against a real isolated git checkout
- component coverage for inactive state, loading/error behavior, send flow, and rollback-cancel behavior
- E2E coverage for availability, send/receive, server prompt receipt, multi-turn context, rollback cancel, and rollback success through the browser UI against an isolated checkout

## Suite Plan

### 1. Unit Tests

Purpose: protect pure logic and edge cases without process or browser overhead.

Targets:

- `packages/core/studio-session.ts`
- extracted helpers from `apps/server/src/studio/agent.ts`
- extracted helpers from `apps/server/src/api/studio.ts`
- extracted helpers from `apps/server/src/studio/git.ts`

Add tests for:

- branch/session resolution edge cases
- `.studio` parsing with valid JSON, invalid JSON, and missing fields
- commit log parsing with empty output, one commit, and multiple commits
- prompt assembly preserving turn order across multi-turn sessions
- prompt assembly including `changes.md` when present and excluding it when absent
- request validation for missing `message` and missing `hash`

Implementation notes:

- extract prompt-building into a pure helper
- extract `.studio` parsing into a pure helper
- extract commit-log parsing into a pure helper

Definition of done:

- all Studio pure logic is covered directly by unit tests

### 2. Integration Tests

Purpose: verify the Bun server behavior for Studio endpoints against real runtime boundaries.

Targets:

- `apps/server/tests/integration/studio-api.test.ts`
- `apps/server/tests/integration/studio-session-memory.test.ts`

Add tests for:

- `GET /studio/status` returns `{ active: false }` without `.studio`
- `GET /studio/status` returns session metadata and commit list with `.studio`
- `POST /studio/chat` returns `403` when Studio mode is off
- `POST /studio/chat` returns `400` when `message` is missing
- `POST /studio/chat` appends turns and sends prior context on subsequent turns
- `POST /studio/reset` clears in-memory session history
- `GET /studio/commits` returns current commit history
- `POST /studio/rollback` returns `400` when `hash` is missing
- `POST /studio/rollback` refreshes commits after rollback
- malformed `.studio` file does not crash the endpoint
- agent/git subprocess failures produce explicit error responses

Infra approach:

- use the existing Vitest + Bun + Postgres integration harness
- use deterministic file or command fixtures for `claude` and `git` boundaries
- keep the tests self-contained and independently runnable

Definition of done:

- every `/studio` endpoint has success and failure coverage

### 3. Component Tests

Purpose: verify `StudioChat` behavior in a real Chromium browser under Vitest.

Target:

- `apps/web/tests/component/studio-chat.test.tsx`

Add tests for:

- loading spinner appears during an in-flight send
- send button stays disabled for blank input
- pressing Enter submits a message
- input disables while a request is in flight
- commit list updates after a successful reply
- rollback confirmation accepted sends the rollback request
- rollback confirmation cancelled does not send the rollback request
- rollback response refreshes the commit list
- failed `/studio/status` request renders a safe fallback
- failed `/studio/chat` request renders an explicit error state
- malformed chat payload renders an explicit error state

Implementation notes:

- `StudioChat` currently swallows most failures; add explicit error rendering before adding these tests
- make rollback interactions testable without relying on hover-only behavior

Definition of done:

- `StudioChat` is covered for render, interaction, loading, rollback, and failure states

### 4. E2E Tests

Purpose: prove the operator-facing Studio workflow works through the full app.

Targets:

- split Studio-focused tests out of `tests/e2e/full.spec.ts` into `tests/e2e/studio.spec.ts` if needed

Add workflows for:

- Studio is unavailable when `.studio` is absent
- Studio is available after login when `.studio` is present
- a multi-turn conversation preserves prior context on the second turn
- a turn updates the visible commit list
- rollback to a prior commit updates the UI commit history
- session reset clears prior context for the next message
- agent failure is surfaced in the UI without crashing the session

Fixture strategy:

- continue using the Claude CLI fixture
- add deterministic git fixture behavior for rollback assertions where needed
- reserve E2E for high-value user workflows, not every edge case

Definition of done:

- the Studio operator workflow is deterministic and protected end to end

## Execution Order

1. Extract pure Studio helpers and add unit tests
2. Add integration coverage for endpoint contracts and session memory
3. Improve `StudioChat` error handling and add component coverage
4. Expand E2E coverage for rollback and reset
5. Split Studio E2E from general smoke coverage if suite runtime becomes too large

## TDD Order

For each area:

1. Write failing tests first
2. Implement the minimum code to pass
3. Refactor only after green
4. Run the canonical suite command for that layer

Canonical commands:

- Unit: `bun --bun vitest run tests/unit apps/*/tests/unit`
- Integration: `bun run test:api`
- Component: `bun --bun vitest run --config apps/web/vitest.browser.config.ts`
- E2E: `bun --bun vitest run --config tests/e2e/vitest.config.ts`

## Acceptance Checklist

- Unit tests cover Studio pure logic and helper edge cases
- Integration tests cover all `/studio` endpoints for success and failure
- Component tests cover `StudioChat` render, send, rollback, loading, and error states
- E2E tests cover availability, multi-turn chat, rollback, and reset
- No Studio work merges without tests in the correct suite
- Local and CI commands remain identical for each suite

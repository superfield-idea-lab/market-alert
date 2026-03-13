# Next Prompt

Read `agent-context/index.md`, `agent-context/development/development-standards.md`, `agent-context/blueprints/testing-blueprint.md`, `agent-context/implementation-ts/testing-implementation.md`, `docs/plans/implementation-plan.md`, and `docs/plans/studio-test-coverage-plan.md` before making further Studio changes.

This branch already has an open PR and is above the preferred size threshold. Do not widen the Studio scope further on `feat/studio-mode` unless the change is directly required to make the existing Studio work mergeable.

If the next commit touches Studio:

1. Preserve the existing suite ownership:
   - unit tests for pure helpers and parsing
   - integration tests for `/studio` endpoint contracts and bootstrap/git behavior
   - component tests for `StudioChat` browser states
   - E2E tests for operator workflows
2. Prefer isolated git checkouts for any destructive Studio verification. Do not mutate the live branch to prove rollback behavior.
3. Run only the canonical suite commands for the layer you change:
   - `bun --bun vitest run tests/unit apps/*/tests/unit`
   - `bun run test:api`
   - `bun --bun vitest run --config apps/web/vitest.browser.config.ts`
   - `bun --bun vitest run --config tests/e2e/vitest.config.ts`
4. Do not assume GitHub Actions PR checkouts have a local `main` branch or an existing git identity. If a Studio test depends on either, provision them explicitly inside the disposable clone.
5. Update `docs/plans/implementation-plan.md` and this file in the same commit.
6. If there is no additional Studio work required for merge, switch to the next highest-priority unchecked item in `docs/plans/implementation-plan.md` on a fresh or rebased branch.

Latest merge blocker fixes on `feat/studio-mode`:

- `scripts/studio-start.ts` must probe `origin/main` / `main` candidates without exiting on the first missing ref.
- Studio commit-list E2E coverage must use an isolated checkout with known session commits; do not depend on the PR checkout's commit topology.
- `scripts/studio-start.ts` must force-add the ignored `.studio` sentinel before the bootstrap commit inside disposable test clones.

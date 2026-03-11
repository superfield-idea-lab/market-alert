# Next Prompt

## Context

Integration tests are now fully self-contained: each suite spins up its own postgres:16 Docker
container and server subprocess via `apps/server/tests/helpers/pg-container.ts` (DIY testcontainers
pattern). No shared external infrastructure needed — works locally and in CI without a pre-started
postgres service or server process. The CI `test-api.yml` workflow was simplified to remove the
postgres service, Start Server, and Wait for Server steps.

Key implementation details:
- `startPostgres()` runs `docker run -d --rm -p 0:5432 postgres:16`, gets the ephemeral port via
  `docker port`, and polls `pg_isready` + `psql SELECT 1` to guard against the "system is starting
  up" race condition where pg_isready exits 0 prematurely.
- Server is spawned with `cwd` set to repo root so Bun can resolve workspace packages (db, core).
- Server now reads `process.env.PORT` (falls back to 31415) for configurable port binding.
- Integration tests use port 31416 to avoid conflicts with a running dev server.

## Next Task — Phase 3: Kanban View

Add a second view mode to the project board: a Kanban board with status columns.

### 1. Add view toggle to App.tsx

In the board header, add a segmented control (List / Kanban) that switches between
`<TaskListView />` and `<KanbanView />`. Store as `boardView: 'list' | 'kanban'` state.

### 2. Build `apps/web/src/components/KanbanView.tsx`

Three columns: **Todo**, **In Progress**, **Done** — each showing tasks filtered by status.

Each task card shows: name, owner, priority badge, due date.

Clicking a card's status badge cycles it (same `PATCH /api/tasks/:id` call as the list view).

No drag-and-drop yet — clicking the status badge moves the card to the next column.

### 3. Component tests

Add `apps/web/tests/component/kanban.test.tsx` using `vitest-browser-react` + mocked fetch:

- Kanban renders three column headers (Todo, In Progress, Done)
- Task with status "todo" appears in the Todo column
- Cycling status moves the card to In Progress column

### Constraints

TypeScript only. Bun for all scripts. No mocks in implementation code. No forbidden packages.

---

## FAILING TESTS — Must be addressed before next push

The following tests were failing at the time of the last push.
They must be **checked, fixed, or rewritten. Never ignore or skip them.**

```

```

For each failure: determine whether the test is wrong (fix the test to match
correct behaviour) or the implementation is wrong (fix the code). Do not
disable, comment out, or add skip/todo markers to avoid addressing failures.

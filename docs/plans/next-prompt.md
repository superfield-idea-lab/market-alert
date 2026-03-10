# Next Prompt

## Context

Phase 2.5 (Test Baseline) is complete. The E2E CI failure has been fixed:

- `playwright.config.ts` now builds the web app then starts the Bun server (port 31415)
- `.github/workflows/test-e2e.yml` has a `postgres:16` service with `DATABASE_URL`
- `tests/e2e/app.spec.ts` tests the actual Calypso UI (login screen + layout shell)
- All workflow files updated from `master` → `main`

All four CI workflows should now be green on the next PR merge to `main`.

## Next Task — Phase 3: The Project Board (List View)

Implement the core task management interface in the 3/4 left pane.

### Step 1 — Data Layer

In `packages/core/types.ts`, add a `Task` type:

```ts
export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface Task {
  id: string;
  name: string;
  description: string;
  owner: string;
  priority: TaskPriority;
  status: TaskStatus;
  estimateStart: string | null; // ISO date
  estimatedDeliver: string | null; // ISO date
  dependsOn: string[]; // Task IDs
  tags: string[];
  createdAt: string;
}
```

In `packages/db/index.ts`, add a `tasks` table to the schema and `migrate()`.

### Step 2 — API

In `apps/server/src/api/tasks.ts`, implement:

- `GET /api/tasks` — return all tasks as JSON
- `POST /api/tasks` — create a task, return the created row

Wire both into `apps/server/src/index.ts`.

### Step 3 — UI

Build `apps/web/src/components/TaskListView.tsx` — an Asana-style data table:

- Columns: checkbox, Name, Owner, Priority, Status, Estimated Deliver
- Inline status toggle (click status cell to cycle: todo → in_progress → done)
- "New Task" button opens a minimal modal/form with required fields

Replace the empty state in `apps/web/src/App.tsx` (Board Content section) with
`<TaskListView />`.

### Step 4 — Tests

- `apps/server/tests/integration/api.test.ts`: test `GET /api/tasks` returns 200
  with an array, `POST /api/tasks` creates a task and returns 201.
- `apps/web/tests/component/App.test.tsx`: test that `<TaskListView />` renders a
  table with expected column headers.

### Constraints

TypeScript only. Bun for all scripts. No mocks. No forbidden packages (redux,
zustand, prisma, etc.).

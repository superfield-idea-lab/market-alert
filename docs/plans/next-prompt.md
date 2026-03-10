# Next Prompt

## Context

Phase 3 List View is complete and blueprint-compliant:

- `packages/db/schema.sql` seeds all entity types (user, task, tag, github_link, channel, message)
- `packages/core/types.ts` exports `Task`, `TaskStatus`, `TaskPriority`
- `apps/server/src/api/tasks.ts` handles `GET /api/tasks`, `POST /api/tasks`, `PATCH /api/tasks/:id`
- `apps/web/src/components/TaskListView.tsx` — table with status cycling, New Task modal
- Component tests run in headless Chromium via `playwright-component.config.ts`
- API integration tests start server + Postgres in CI (`test-api.yml`)
- `wait-on` added as dev dependency for server readiness check

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

Add `apps/web/tests/component/kanban.spec.ts` — Playwright tests in headless Chromium:

- Kanban renders three column headers (Todo, In Progress, Done)
- Creating a task and switching to Kanban shows it in the Todo column
- Cycling status moves the card to the correct column

### Constraints

TypeScript only. Bun for all scripts. No mocks. No forbidden packages.

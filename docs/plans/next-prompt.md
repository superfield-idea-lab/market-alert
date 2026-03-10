# Next Prompt

## Context

Git hooks are now installed and enforced. The repository enforces:

- Commit message metadata schema (GIT_BRAIN_METADATA block with retroactive_prompt, outcome, context, agent, session, hints).
- Conformance checklist (CALYPSO_CHECKLIST) completion on every commit.
- Planning doc presence (implementation-plan.md and next-prompt.md must be staged when modified).
- Blueprint violation audit on push.
- PR size limits.

Phase 1 (Infrastructure) and Phase 2 (Core UX Layout) are complete.

## Next Task — Phase 3: The Project Board

Implement the task management interface in the 3/4 left pane.

**Start with the List View:**

1. Create a `Task` type in `packages/core/types.ts` with fields: `id`, `name`, `description`, `owner`, `priority`, `estimateStart`, `estimatedDeliver`, `dependsOn`, `status`, `tags`.
2. Add a `GET /tasks` and `POST /tasks` API endpoint in `apps/server/src/api/`.
3. Build a `<TaskListView>` component in `apps/web/src/components/` — an Asana-style data table with inline editing and checkboxes per row.
4. Wire it into the 3/4 left pane in `apps/web/src/App.tsx`.
5. Add unit tests for the API endpoints and component tests for `<TaskListView>`.

Follow all blueprint constraints: TypeScript only, bun for all scripts, no mocks, no forbidden packages.

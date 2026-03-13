# Studio Mode

## Overview

Studio Mode is a developer-facilitated tool for running UI feedback sessions with Calypso integration partners. A non-technical partner describes what they want to change in plain language, the AI agent modifies the running UI in real time, and the session produces a structured artifact for engineering to act on.

V0 is operator-run: a developer sits with the partner, manages the environment, and hands off the artifacts at the end. The goal is to validate the feedback loop before building any self-service infrastructure.

---

## Problem Statement

Integration partners are business-domain experts, not engineers. They need to:

- Evaluate whether Calypso's UI and workflows fit their operational reality
- Propose changes based on what they see on screen
- Do this without touching a codebase or understanding a data model

Calypso must not allow scope creep into service architecture or data model decisions during these sessions — but it must not lose the signal either. Partner feedback has direct value for the development process.

---

## What the Agent Can Do

The agent can touch anything in the codebase — UI, server, schema, packages. Studio sessions are explicitly exploratory. Things can and will break. That is acceptable and expected.

The DB is read-only. The agent can propose schema changes and modify server code, but it cannot write to the database. Changes that require new data will break at runtime — this is visible and informative, not a failure state.

All output is advisory. The branch is never merged. A separate agent does the mainline implementation work using the session artifacts as input.

---

## Entering Studio Mode

Studio mode is started with:

```bash
bun run studio
```

This script:

1. Resolves the main branch hash (`origin/main`, `origin/master`, `main`, or `master`)
2. Generates a session ID (short random slug, e.g. `a3f9`)
3. If `STUDIO_ENFORCE_BRANCH=1`, creates and checks out a branch named `studio/session-{mainHash}-{id}`
4. Starts a disposable Postgres container on a random port
5. Writes a `.studio` file at the repo root containing the session ID, branch, and start timestamp — this is how the server and agent know they are in a studio session
6. Commits the `.studio` file and session `changes.md` with `--no-verify`
7. Pushes the branch to the remote immediately so the session is visible to collaborators

The `.studio` file is committed as the first commit on the branch. Its presence on the current branch is the signal the server checks at startup. If the server starts and `.studio` is not present, studio mode endpoints are disabled.

When the server starts in studio mode, it logs a clear indication:

```
⬡ Studio Mode — session a3f9 on branch studio/session-1a2b3c-a3f9
  Commits: --no-verify enforced
  DB: disposable (reset with bun run studio:db-reset)
  Exit: bun run studio:end
```

The agent's system prompt is loaded with studio mode context when the server is in this state. Outside of a `.studio` session the `/studio/chat` endpoint returns 403.

### The Session Record

The branch on the remote is the permanent record. There is no formal end step — the session is over when the operator is done. The `diff.patch` artifact can be generated at any time with `git diff main -- . > docs/studio-sessions/{branch}/diff.patch`.

---

## Runtime Environment

```
git worktree add ../calypso-studio origin/main
cd ../calypso-studio
bun run studio
```

The session runs against a disposable Postgres container. By default, `bun run studio` uses the current branch/worktree without enforcing branch naming or a clean worktree. To re-enable the original behavior, set `STUDIO_ENFORCE_BRANCH=1` and use a dedicated worktree so the studio branch rules are exercised and no unrelated changes are captured. Commits are created with `--no-verify` to avoid local hook friction.

Studio uses a dedicated web port by default to avoid conflicts with other dev servers:

- API: `STUDIO_API_PORT` (default `31415`, expected to be running separately)
- Web: `STUDIO_PORT` (default `5174`)

The Postgres container is fully writable. The agent can run migrations, insert data, and change the schema. When the container is discarded and restarted, it returns to its seed state. If the agent has changed the schema or depends on data it inserted during the session, a container reset will break the session.

**This is a known risk, not a bug.** The operator and agent should both understand: if a data model change was made without updating the seed, a container reset will produce errors. The right response is either to update the seed before resetting, or to accept the breakage and treat it as signal that the schema change needs proper seed coverage before it can be relied on.

---

## How a Session Works

The existing chat panel in the app (currently a "Team Chat" placeholder) becomes the studio interface. The partner types feedback in plain language. The agent responds, modifies the codebase, and commits. Vite picks up the file changes via HMR and the UI updates within seconds.

The chat panel shows two things: the conversation, and a running list of commits made during the session. Each commit entry displays the agent's message and a rollback button.

The agent call is server-side. The client sends plain text to `POST /studio/chat`. The server manages the Claude API key, system prompt, and session context — the full message history sent to Claude on each turn, plus the current state of `changes.md`. The partner has no direct API access.

Session context is held in server memory. It is cleared if the server restarts; rollback does not clear it (the conversation history remains visible even after a rollback).

---

## Rollback

The chat panel displays the full commit history for the current session alongside the conversation. Each commit entry shows the agent's commit message and a rollback button.

Rolling back to a prior commit does a hard reset to that point:

```bash
git reset --hard <commit-hash>
```

Vite picks up the file changes and the UI reverts immediately. Commits after the rollback point are lost — this is intentional. The partner and operator are choosing to discard that branch of exploration.

Rolling back the code does not roll back the database. If the agent ran migrations or inserted data before the rollback point, the DB is now ahead of the code. This may cause errors. The operator can reset the Postgres container to its seed state, but if the seed does not match what the rolled-back code expects, the session will be in a broken state until the seed is updated or the container is brought forward again.

---

## Git as the Session Log

Every agent turn produces a commit:

- The code change in `apps/web/src/`
- An updated `docs/studio-sessions/{branch}/changes.md`
- A commit message written by the agent describing the turn

`git log --oneline` is a readable turn-by-turn history. `git diff main` is the complete delta.

---

## Artifacts

Two files are produced on the branch:

### `docs/studio-sessions/{branch}/changes.md`

The agent maintains this file throughout the session. It is updated after every turn — not reconstructed at the end. It records what was changed, why, and what backend work would be needed to support each change in production.

Example mid-session state:

```markdown
# Studio Session — Meridian Logistics

**Domain:** Fleet dispatch operations
**Started:** 2026-03-11 14:02 UTC

## Changes

### Turn 1 — Task list grouped by status

The partner found date-based grouping confusing for dispatch work. Tasks are now grouped
by status (Pending, In Progress, Completed). No backend changes needed.

### Turn 2 — Renamed "Tasks" to "Dispatches" throughout

Label change only across all headings, buttons, and empty states. No backend changes needed.

### Turn 3 — Priority badge on each dispatch card

Added a priority badge (Low / Medium / High / Urgent). Displaying placeholder values.
**Requires backend:** `priority` property on task entities (enum), exposed in the API.

### Turn 4 — SLA countdown timer

Added a time-remaining column. Hardcoded placeholder.
**Requires backend:** `sla_deadline` timestamp on task entities, computed or real-time value from API.

## Backend Implications

- `priority` enum field on task entities (schema + API)
- `sla_deadline` timestamp on task entities (schema + API + breach logic)

## Notes

Partner strongly prefers list view. "Dispatches" is their terminology. SLA visibility is
a hard requirement — currently tracked manually in a spreadsheet.
```

### `docs/studio-sessions/{branch}/diff.patch`

Generated at session end from `git diff main -- apps/web/src/`. The complete code delta alongside the narrative. Together these are the handoff to engineering.

---

## Handoff to Mainline Development

The artifacts are input to a separate agent doing mainline feature work on `main`. That agent reads the narrative for intent and the diff for what was prototyped, then implements the changes properly — including schema, API, and test coverage.

Studio output is signal, not specification. The mainline agent decides how to implement it.

---

## Key Files

| Path                                       | Purpose                                                     |
| ------------------------------------------ | ----------------------------------------------------------- |
| `scripts/studio-start.ts`                  | `studio` — branch creation, `.studio` file, container start |
| `apps/web/src/components/StudioChat.tsx`   | Chat panel UI — conversation + commit list + rollback       |
| `apps/server/src/api/studio.ts`            | Chat endpoint, Claude API proxy, session context            |
| `apps/server/src/studio/agent.ts`          | System prompt, tool definitions                             |
| `apps/server/src/studio/git.ts`            | Commit-after-turn, rollback, session log                    |
| `docs/studio-sessions/{branch}/changes.md` | Agent-maintained narrative, updated each turn               |
| `docs/studio-sessions/{branch}/diff.patch` | Generated at session end from `git diff main`               |

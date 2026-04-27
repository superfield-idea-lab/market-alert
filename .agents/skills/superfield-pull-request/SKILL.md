---
name: superfield-pull-request
description: User-facing wrapper for the Superfield pull request workflow. Use when the user explicitly asks to run the repository's pull-request command workflow.
---

# Superfield Pull Request

This skill exists because Codex currently discovers repository skills, but does not expose repository `.agents/commands/*.md` files as custom slash commands.

Use this skill only when the user explicitly invokes `superfield-pull-request` or clearly asks to run that command workflow.

## Workflow

1. Read [`../../commands/superfield-pull-request.md`](../../commands/superfield-pull-request.md).
2. Treat that command file as the orchestration source of truth.
3. Execute the workflow it defines without inventing alternate repository process.
4. Keep issue, PR, and checklist state aligned with repository rules.

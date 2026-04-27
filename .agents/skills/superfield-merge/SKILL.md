---
name: superfield-merge
description: User-facing wrapper for the Superfield merge workflow. Use when the user explicitly asks to perform the repository's deterministic merge flow for the current selected PR.
---

# Superfield Merge

This skill exists because Codex currently discovers repository skills, but does not expose repository `.agents/commands/*.md` files as custom slash commands.

Use this skill only when the user explicitly invokes `superfield-merge` or clearly asks to run that command workflow.

## Workflow

1. Read [`../../commands/superfield-merge.md`](../../commands/superfield-merge.md).
2. Treat that command file as the orchestration source of truth.
3. Execute only the deterministic merge actions described there.
4. Use the shared `.agents/scripts/auto/` helpers as the source of truth for readiness and merge state.
5. Do not broaden scope beyond the selected PR.

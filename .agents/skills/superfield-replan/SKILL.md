---
name: superfield-replan
description: User-facing wrapper for the Superfield replan workflow. Use when the user explicitly asks to audit compliance and rewrite the Plan around phase-aware scout-gated execution.
---

# Superfield Replan

This skill exists because Codex currently discovers repository skills, but does not expose repository `.agents/commands/*.md` files as custom slash commands.

Use this skill only when the user explicitly invokes `superfield-replan` or clearly asks to run that command workflow.

## Workflow

1. Read [`../../commands/superfield-replan.md`](../../commands/superfield-replan.md).
2. Treat that command file as the orchestration source of truth.
3. Execute its deterministic audit, ranking, and apply flow.
4. Invoke internal Superfield skills only when the command file says to do so.
5. Preserve the repository's phase-aware scout-gated Plan policy.

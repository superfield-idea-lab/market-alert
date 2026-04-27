---
name: superfield-replan-apply
description: User-facing wrapper for the Superfield replan apply workflow. Use when the user explicitly asks to apply a prepared phase-aware Plan result.
---

# Superfield Replan Apply

This skill exists because Codex currently discovers repository skills, but does not expose repository `.agents/commands/*.md` files as custom slash commands.

Use this skill only when the user explicitly invokes `superfield-replan-apply` or clearly asks to run that command workflow.

## Workflow

1. Read [`../../commands/superfield-replan-apply.md`](../../commands/superfield-replan-apply.md).
2. Treat that command file as the orchestration source of truth.
3. Apply the prepared Plan result using the deterministic helpers it references.
4. Keep cross-phase ordering metadata in the Plan issue while preserving stable
   phase metadata in issue bodies.

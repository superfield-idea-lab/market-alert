---
name: superfield-feature
description: User-facing wrapper for the Superfield feature intake workflow. Use when the user explicitly asks to evaluate a feature request, create the issue, and update the Plan.
---

# Superfield Feature

This skill exists because Codex currently discovers repository skills, but does not expose repository `.agents/commands/*.md` files as custom slash commands.

Use this skill only when the user explicitly invokes `superfield-feature` or clearly asks to run that command workflow.

## Workflow

1. Read [`../../commands/superfield-feature.md`](../../commands/superfield-feature.md).
2. Treat that command file as the orchestration source of truth.
3. Execute the deterministic validation, evaluation, issue creation, and Plan update flow it defines.
4. Invoke internal Superfield skills only when the command file says to do so.
5. Preserve repository issue and Plan formatting rules from `AGENTS.md`.

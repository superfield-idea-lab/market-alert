---
name: superfield-develop
description: User-facing wrapper for the Superfield develop workflow. Use when the user explicitly asks to develop the currently selected Plan issue through merge.
---

# Superfield Develop

This skill exists because Codex currently discovers repository skills, but does not expose repository `.agents/commands/*.md` files as custom slash commands.

Use this skill only when the user explicitly invokes `superfield-develop` or clearly asks to run that command workflow.

## Workflow

1. Read [`../../commands/superfield-develop.md`](../../commands/superfield-develop.md).
2. Treat that command file as the orchestration source of truth.
3. Execute its deterministic prep and development flow exactly as described.
4. Invoke internal Superfield skills only when the command file says to do so.
5. Follow the repository's Plan ordering and completion rules from `AGENTS.md`.

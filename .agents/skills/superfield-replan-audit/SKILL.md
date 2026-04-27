---
name: superfield-replan-audit
description: User-facing wrapper for the Superfield replan audit workflow. Use when the user explicitly asks to audit issue and PR compliance before replanning.
---

# Superfield Replan Audit

This skill exists because Codex currently discovers repository skills, but does not expose repository `.agents/commands/*.md` files as custom slash commands.

Use this skill only when the user explicitly invokes `superfield-replan-audit` or clearly asks to run that command workflow.

## Workflow

1. Read [`../../commands/superfield-replan-audit.md`](../../commands/superfield-replan-audit.md).
2. Treat that command file as the orchestration source of truth.
3. Run the compliance audit flow it defines using the deterministic replan scripts.
4. Surface concrete audit findings before any Plan rewrite.

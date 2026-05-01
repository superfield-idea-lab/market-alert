---
name: superfield-decision
description: Extract decisions from a busy human expert using at most 3 yes/no questions, chosen for maximum information gain.
user_invocable: false
---

# Expert Decision

Use this skill when you have open questions that require human expert judgment
before you can proceed. It applies to any response the agent produces —
a design review, implementation plan, code analysis, operational decision,
product tradeoff, or any other situation where you have identified decisions you
cannot resolve on your own.

Resolve open decisions from a human expert in ≤3 turns. One yes/no question per
turn. Each question is chosen to collapse the most downstream decisions by
implication, regardless of which way the answer goes.

## When to use

- You have identified open decisions that require human judgment and cannot be
  safely assumed or deferred.
- The human is domain-expert but time-constrained — they cannot read a wall of
  questions or hold a lengthy discussion.
- You need crisp, actionable answers to proceed with confidence.

## Must do

- Collect all open questions and decisions before starting the session.
- Present each question clearly, preceded by turn count (`Question 1 of 3:`)
  so the human knows the budget upfront.
- After the session, use the emitted decision record to close open questions and
  proceed.
- Document any `unresolved` decisions along with the default assumption you will
  use in their place.

## Must not do

- Do not ask more than one question per turn.
- Do not ask open-ended or multi-part questions.
- Do not surface the decision graph or scoring internals to the human.
- Do not skip the session and guess at human preferences.
- Do not run more than one session per response without informing the human.

## Invocation flow

1. Gather all open decisions into a list.
2. Write a one-sentence context summary describing what is being decided.
3. Write the decision graph to `/tmp/superfield-decision-{session-id}.json`.
4. Present the first question to the human. Wait for their answer.
5. Update the graph and select the next question (if any remain and turns < 3).
6. Repeat until the final decision record is emitted.
7. Integrate the decision record and proceed.

## Example exchange

The agent has 7 open decisions after analyzing an auth system. It writes the
decision graph, scores all nodes by information gain, and identifies that the
stateless-vs-stateful question resolves 4 downstream nodes by implication.

**Turn 1**
> I have a few open decisions on the auth system — at most 3 yes/no questions.
> **Question 1 of 3:** Should user sessions be stateless (JWT-only, no server-side store)?

## Before turn 1

Write `/tmp/superfield-decision-{session-id}.json`:

```json
{
  "session_id": "string",
  "context": "One sentence.",
  "decisions": [
    {
      "id": "D1",
      "question": "Natural-language form of the decision.",
      "status": "open",
      "answer": null,
      "inferred_from": null,
      "if_yes_resolves": ["D3", "D5"],
      "if_no_resolves": ["D2"],
      "gain": 0.87
    }
  ],
  "turns": []
}
```

`gain` = fraction of remaining open decisions this question resolves (directly
or by inference), estimated 0–1. Always ask the highest-`gain` open node.

## Each turn

1. Select the `open` node with the highest `gain`.
2. Ask it as a single yes/no sentence. Prefix: `Question N of 3:`.
3. Record the answer in `turns`. Set node `status` to `answered`.
4. Walk `if_yes_resolves` or `if_no_resolves` — set each listed node to
   `status: inferred`, `inferred_from: "DN"`. Do not ask inferred nodes.
5. Recompute `gain` for remaining `open` nodes. Repeat.

Stop after 3 turns or when no `open` nodes remain.

## Rules

- Never ask more than one question per turn.
- Never ask an `inferred` node.
- Never ask an open-ended question.
- Never show the graph to the human.
- If the human adds context beyond yes/no, update the graph before continuing.

## Output

Emit after the final turn:

```json
{
  "session_id": "string",
  "decisions": [
    {
      "id": "D1",
      "question": "Natural-language form.",
      "resolution": "answered | inferred | unresolved",
      "answer": true,
      "basis": "Turn 1 direct answer."
    }
  ],
  "unresolved": ["D4"],
  "summary": "One paragraph covering all resolved decisions."
}
```

For each `unresolved` node, the invoking agent must document a default
assumption and proceed.

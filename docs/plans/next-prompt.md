# Next Prompt

## Context

The repo now sources the canonical blueprint docs from the `./calypso-blueprint`
git submodule while `.github/workflows/` and `agent-context/workflows/` remain
localized workflow trees. CI workflow drift has already been corrected, and
the flaky StudioChat component test no longer depends on one shared
fixture-state reset across files.

The remaining next priority is still the failing Studio API integration suite
reported by the push hooks.

## Next Action

Read these files first:

1. `apps/server/tests/integration/studio-api.test.ts`
2. `apps/server/src/api/studio.ts`
3. `apps/server/src/studio/agent.ts`
4. `docs/plans/implementation-plan.md`
5. this file

Then do this next:

1. Reproduce the failing Studio API integration tests.
2. Determine whether each failure is in the tests or the implementation.
3. Fix them without weakening coverage.
4. After the Studio API suite is green, reconcile the remaining implementation companions to the current workflow YAMLs and release-gate model.

After editing, update `docs/plans/implementation-plan.md` and overwrite this file with the next self-contained prompt.

---

# PR Due — Open Before Continuing

This branch has changed more than 20 files since main. A pull request must be opened
imminently. Do this before starting the next feature task:

1. Ensure lint and types are clean.
2. Push the branch: `git push`
3. Open a PR: `gh pr create`
4. After merge, pull main and continue on a fresh or rebased branch.

Do not accumulate further unreviewed changes on this branch.

---

# PR Size Warning

This PR is above the 20-file warning threshold. Consider splitting follow-up work into smaller, focused PRs.

---

## FAILING TESTS — Must be addressed before next push

The following tests were failing at the time of the last push.
They must be **checked, fixed, or rewritten. Never ignore or skip them.**

```
   × Studio API integration > GET /studio/status returns inactive when .studio is absent 39ms
   × Studio API integration > GET /studio/status returns session metadata when .studio is present 17ms
   × Studio API integration > POST /studio/chat returns 403 when studio mode is inactive 121ms
   × Studio API integration > POST /studio/chat returns 400 when message is missing 2ms
   × Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session 1ms
   × Studio API integration > POST /studio/reset clears prior session context 1ms
   × Studio API integration > POST /studio/rollback returns 400 when hash is missing 1ms
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns inactive when .studio is absent
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns session metadata when .studio is present
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 403 when studio mode is inactive
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 400 when message is missing
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/reset clears prior session context
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/rollback returns 400 when hash is missing
```

For each failure: determine whether the test is wrong (fix the test to match
correct behaviour) or the implementation is wrong (fix the code). Do not
disable, comment out, or add skip/todo markers to avoid addressing failures.

---

## FAILING TESTS — Must be addressed before next push

The following tests were failing at the time of the last push.
They must be **checked, fixed, or rewritten. Never ignore or skip them.**

```
   × Studio API integration > GET /studio/status returns inactive when .studio is absent 39ms
   × Studio API integration > GET /studio/status returns session metadata when .studio is present 17ms
   × Studio API integration > POST /studio/chat returns 403 when studio mode is inactive 121ms
   × Studio API integration > POST /studio/chat returns 400 when message is missing 2ms
   × Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session 1ms
   × Studio API integration > POST /studio/reset clears prior session context 1ms
   × Studio API integration > POST /studio/rollback returns 400 when hash is missing 1ms
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns inactive when .studio is absent
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns session metadata when .studio is present
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 403 when studio mode is inactive
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 400 when message is missing
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/reset clears prior session context
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/rollback returns 400 when hash is missing
```

For each failure: determine whether the test is wrong (fix the test to match
correct behaviour) or the implementation is wrong (fix the code). Do not
disable, comment out, or add skip/todo markers to avoid addressing failures.

---

# PR Due — Open Before Continuing

This branch has changed 211 files since main. A pull request must be opened
imminently. Do this before starting the next feature task:

1. Ensure lint and types are clean.
2. Push the branch: `git push`
3. Open a PR: `gh pr create`
4. After merge, pull main and continue on a fresh or rebased branch.

Do not accumulate further unreviewed changes on this branch.

---

# PR Size Warning

This PR has 211 files changed (limit: 20). Consider splitting into smaller, more focused PRs.

---

## FAILING TESTS — Must be addressed before next push

The following tests were failing at the time of the last push.
They must be **checked, fixed, or rewritten. Never ignore or skip them.**

```
   × Studio API integration > GET /studio/status returns inactive when .studio is absent 38ms
   × Studio API integration > GET /studio/status returns session metadata when .studio is present 13ms
   × Studio API integration > POST /studio/chat returns 403 when studio mode is inactive 126ms
   × Studio API integration > POST /studio/chat returns 400 when message is missing 1ms
   × Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session 1ms
   × Studio API integration > POST /studio/reset clears prior session context 1ms
   × Studio API integration > POST /studio/rollback returns 400 when hash is missing 1ms
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns inactive when .studio is absent
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns session metadata when .studio is present
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 403 when studio mode is inactive
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 400 when message is missing
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/reset clears prior session context
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/rollback returns 400 when hash is missing
```

For each failure: determine whether the test is wrong (fix the test to match
correct behaviour) or the implementation is wrong (fix the code). Do not
disable, comment out, or add skip/todo markers to avoid addressing failures.

---

## Commit Size Warning

The previous commit touched 116 files (limit: 10).
Commits should be small and focused. If the next task touches many files, split it.

---

# PR Due — Open Before Continuing

This branch has changed 105 files since main. A pull request must be opened
imminently. Do this before starting the next feature task:

1. Ensure lint and types are clean.
2. Push the branch: `git push`
3. Open a PR: `gh pr create`
4. After merge, pull main and continue on a fresh or rebased branch.

Do not accumulate further unreviewed changes on this branch.

---

# PR Size Warning

This PR has 105 files changed (limit: 20). Consider splitting into smaller, more focused PRs.

---

## FAILING TESTS — Must be addressed before next push

The following tests were failing at the time of the last push.
They must be **checked, fixed, or rewritten. Never ignore or skip them.**

```
   × Studio API integration > GET /studio/status returns inactive when .studio is absent 41ms
   × Studio API integration > GET /studio/status returns session metadata when .studio is present 16ms
   × Studio API integration > POST /studio/chat returns 403 when studio mode is inactive 125ms
   × Studio API integration > POST /studio/chat returns 400 when message is missing 1ms
   × Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session 1ms
   × Studio API integration > POST /studio/reset clears prior session context 1ms
   × Studio API integration > POST /studio/rollback returns 400 when hash is missing 1ms
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns inactive when .studio is absent
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns session metadata when .studio is present
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 403 when studio mode is inactive
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 400 when message is missing
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/reset clears prior session context
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/rollback returns 400 when hash is missing
```

For each failure: determine whether the test is wrong (fix the test to match
correct behaviour) or the implementation is wrong (fix the code). Do not
disable, comment out, or add skip/todo markers to avoid addressing failures.

---

# PR Due — Open Before Continuing

This branch has changed 103 files since main. A pull request must be opened
imminently. Do this before starting the next feature task:

1. Ensure lint and types are clean.
2. Push the branch: `git push`
3. Open a PR: `gh pr create`
4. After merge, pull main and continue on a fresh or rebased branch.

Do not accumulate further unreviewed changes on this branch.

---

# PR Due — Open Before Continuing

This branch has changed 29 files since main. A pull request must be opened
imminently. Do this before starting the next feature task:

1. Ensure lint and types are clean.
2. Push the branch: `git push`
3. Open a PR: `gh pr create`
4. After merge, pull main and continue on a fresh or rebased branch.

Do not accumulate further unreviewed changes on this branch.

---

# PR Size Warning

This PR has 29 files changed (limit: 20). Consider splitting into smaller, more focused PRs.

---

## FAILING TESTS — Must be addressed before next push

The following tests were failing at the time of the last push.
They must be **checked, fixed, or rewritten. Never ignore or skip them.**

```
   × Studio API integration > GET /studio/status returns inactive when .studio is absent 29ms
   × Studio API integration > GET /studio/status returns session metadata when .studio is present 12ms
   × Studio API integration > POST /studio/chat returns 403 when studio mode is inactive 281ms
   × Studio API integration > POST /studio/chat returns 400 when message is missing 2ms
   × Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session 1ms
   × Studio API integration > POST /studio/reset clears prior session context 1ms
   × Studio API integration > POST /studio/rollback returns 400 when hash is missing 2ms
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns inactive when .studio is absent
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns session metadata when .studio is present
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 403 when studio mode is inactive
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 400 when message is missing
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/reset clears prior session context
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/rollback returns 400 when hash is missing
```

For each failure: determine whether the test is wrong (fix the test to match
correct behaviour) or the implementation is wrong (fix the code). Do not
disable, comment out, or add skip/todo markers to avoid addressing failures.

---

# PR Size Warning

This PR has 35 files changed (limit: 20). Consider splitting into smaller, more focused PRs.

---

# PR Due — Open Before Continuing

This branch has changed 36 files since main. A pull request must be opened
imminently. Do this before starting the next feature task:

1. Ensure lint and types are clean.
2. Push the branch: `git push`
3. Open a PR: `gh pr create`
4. After merge, pull main and continue on a fresh or rebased branch.

Do not accumulate further unreviewed changes on this branch.

---

# PR Size Warning

This PR has 36 files changed (limit: 20). Consider splitting into smaller, more focused PRs.

---

## FAILING TESTS — Must be addressed before next push

The following tests were failing at the time of the last push.
They must be **checked, fixed, or rewritten. Never ignore or skip them.**

```
   × Studio API integration > GET /studio/status returns inactive when .studio is absent 40ms
   × Studio API integration > GET /studio/status returns session metadata when .studio is present 18ms
   × Studio API integration > POST /studio/chat returns 403 when studio mode is inactive 100ms
   × Studio API integration > POST /studio/chat returns 400 when message is missing 1ms
   × Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session 1ms
   × Studio API integration > POST /studio/reset clears prior session context 1ms
   × Studio API integration > POST /studio/rollback returns 400 when hash is missing 1ms
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns inactive when .studio is absent
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > GET /studio/status returns session metadata when .studio is present
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 403 when studio mode is inactive
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat returns 400 when message is missing
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/chat preserves prior turns across a multi-turn session
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/reset clears prior session context
 FAIL |server|  tests/integration/studio-api.test.ts > Studio API integration > POST /studio/rollback returns 400 when hash is missing
```

For each failure: determine whether the test is wrong (fix the test to match
correct behaviour) or the implementation is wrong (fix the code). Do not
disable, comment out, or add skip/todo markers to avoid addressing failures.

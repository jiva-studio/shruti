---
name: mutation-and-gaps
description: Review Stage 4 — the mutation claim and test-gap analysis. Runs make mutate-diff for mobile changes, measures coverage of the touched packages, and prescribes prioritised tests.
---

# Stage 4: Mutation & Test Gaps

## 1. Mutation (band's `mutation` claim)

When the diff touches `modules/apps/mobile`:

```bash
make mutate-diff
```

It runs Stryker over the `.ts` files this branch changed (committed and
uncommitted) against the merge base with main; `.vue` files, tests, `index.ts`
and `types.ts` are excluded. It exits non-zero only when the mutation score falls
below the `break` threshold in `modules/apps/mobile/stryker.config.json` (50);
survivors above that threshold do not fail it. A survivor is a line the suite
would not notice being wrong: report each one from the clear-text output.

The mobile app is the only package with a mutation configuration. For other
packages, record "not applicable" and rely on the hand check: for each new test,
break the property it defends and confirm it goes red.

## 2. Coverage

```bash
make coverage PKG=<pkg>
```

For chat this also enforces the per-package floors in `pyproject.toml`
(`[tool.coverage_floors]`); they are never lowered to go green.

## 3. Blind spots

Scan the diff for:

1. **Error paths** — `if err != nil` branches, database busy or locked, context
   cancelled, network failure mid-sync.
2. **Boundaries** — empty and oversized input, malformed payloads.
3. **Concurrency** — two requests on one row, two devices on one document,
   repeated submission before the first resolves.
4. **Wire drift** — optional fields, old clients, new fields ignored by old
   builds.
5. **Properties** — round trips, idempotent re-indexing, any permutation of sync
   events converging on the same state.

## 4. Recommendations

A table of P1/P2/P3 tests in *Given → When → Then* form, each naming the file
it belongs in.

## Output

Stage 4 of the report in [`../SKILL.md`](../SKILL.md).

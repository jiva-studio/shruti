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

It runs Stryker over the files this branch changed against the merge base with
main. It passes when the score meets the package threshold and no mutant
survives outside `.agents/tasks/<slug>/artifacts/mutant_waivers.json`. A
survivor is a line the suite would not notice being wrong: report each one.

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

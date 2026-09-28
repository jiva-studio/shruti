---
name: completeness
description: Review Stage 0 — the gatekeeper and hygiene claims. Reconciles the diff against the task's acceptance criteria, hunts stubs and skipped tests, and checks that new code is wired and reachable.
---

# Stage 0: Completeness (gatekeeper + hygiene)

The first line of defence against a change that claims to be done and is not.
Fail-fast: anything missing or stubbed rejects the diff before later stages run.

## 1. Acceptance criteria (gatekeeper)

1. If `.agents/tasks/<slug>/` exists, read `intent.md`, `spec.md` and
   `done.yaml`. Otherwise take the requirements from the PR description, the
   issue and the commit messages.
2. For every acceptance criterion in `spec.md`, locate the lines in the diff
   that deliver it and the test that proves it. A criterion with neither is
   **MISSING**.
3. Every non-goal in `intent.md` is still untouched.
4. If `done.yaml` exists, every claim in it is one this review will be able to
   evaluate (Stage 1 runs the `make` claims, Stage 3 writes the `critic`
   artifact, Stage 4 runs the `mutation` claim).

## 2. Hygiene

Band's `hygiene` claim, over the added lines of the diff:

```bash
git diff "$BASE"...HEAD | grep -nE '^\+.*\b(TODO|FIXME|XXX)\b|Not implemented|\b(it|test|describe)\.skip\b|\bx(it|describe)\b|t\.Skip\(|pytest\.mark\.skip'
```

Also by reading:

- placeholder returns standing in for logic (`return nil`, `return {}`, `pass`);
- errors dropped: `catch {}`, `.catch(() => undefined)`, `except Exception: pass`,
  `_ = fn()`;
- handlers bound to nothing, buttons with no action.

## 3. Wiring and reachability

- A new use case is called from a store, composable or handler.
- A new Go handler is registered on the router in `cmd/<service>/main.go`.
- A new component is rendered; a new route is reachable from navigation.
- A new migration is picked up by the runner (Go services, the mobile user
  database under `infra/persistence/migrations/user/`).
- New exports are re-exported where consumers import from.

## Output

Stage 0 of the report in [`../SKILL.md`](../SKILL.md). Any MISSING criterion,
hygiene hit or orphan: verdict **REJECTED**, with locations.

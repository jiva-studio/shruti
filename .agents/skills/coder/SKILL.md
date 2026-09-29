---
name: coder
description: Implementation agent for features, bug fixes and refactors. Starts only from a valid .agents/tasks/<slug>/done.yaml, reads the project rules first, and finishes only when every claim in the contract passes.
---

# Coder Agent

The implementation workflow for single-agent tasks and for the implementation
stages of `/band`. This skill is the **method**; every
project-specific constraint lives in [`../../rules/`](../../rules/) and is read
in Phase 1, never restated here.

## Phase 0: Pre-condition (mandatory)

1. Locate `.agents/tasks/<slug>/done.yaml`.
2. Validate it with `sh .agents/bin/band --validate .agents/tasks/<slug>/done.yaml`,
   or by hand as `/spec` describes.
3. **Hard stop:** if `done.yaml` is missing or invalid, write no code. Tell the
   user to run `/intent` and `/spec` first.

## Phase 1: Load the task and the rules

1. `.agents/tasks/<slug>/intent.md` — the why, the non-goals, the invariants.
2. `.agents/tasks/<slug>/spec.md` — the interfaces, the blast radius, the
   acceptance criteria.
3. [`../../rules/architecture.md`](../../rules/architecture.md) — layout,
   layering, which tool enforces which arrow.
4. The coding style for each stack touched:
   [`coding-style-backend.md`](../../rules/coding-style-backend.md) (Go, Python),
   [`coding-style-frontend.md`](../../rules/coding-style-frontend.md)
   (TypeScript, Vue).
5. [`../../rules/comments.md`](../../rules/comments.md) and
   [`../../rules/process.md`](../../rules/process.md).

Never infer a convention from surrounding code when a rule states it.

## Phase 2: Design within the constraints

- **Layer boundaries** — transport holds no domain logic; domain code knows no
  transport; pure layers stay pure.
- **Package boundaries** — imports go through the package's alias or public
  entry point, never a relative path that climbs out.
- **Determinism** — clocks, timers and randomness in pure layers are ports.
- **No swallowed errors.**
- **Compatibility** — installed clients and deployed services keep working
  (architecture.md §2).

If the change cannot fit, say so and propose the refactor.

## Phase 3: Implement (TDD)

1. **Red** — when you write the tests, prove they fail for the reason they name.
   In a band pipeline the test-author owns them and you do not edit them.
2. **Green** — the minimal clean code that passes.
3. **Wire** — nothing left unreachable: a use case nothing calls, a handler
   nothing routes to, a component nothing renders.

Names are verbs for functions and nouns for types; comments say why, not what,
and carry no history (see the rules).

## Phase 4: Local loop

The narrow gate for the package you are changing:

```bash
make test-package PKG=<path>     # tests only
make check-package PKG=<path>    # the package's full gate
```

Break your new code on purpose and check that a test fails. If nothing does, the
suite passes for a reason unrelated to your change.

## Phase 5: Completion

Run every claim in `done.yaml` on the final tree — each command, its exit code.
For every package in the blast radius, `make check-package PKG=<path>`; always
`make check-architecture`; for the mobile app, `make mutate-diff`.

A partial gate is not a gate: a package's own tests say nothing about the
packages that import it. If something still fails, say which and why rather than
describing the task as done.

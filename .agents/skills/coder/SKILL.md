---
name: coder
description: Implementation agent for features, bug fixes and refactors. Reads the project's architecture and coding-style rules, respects the spec if one exists, and finishes only when the quality gate passes.
---

# Coder Agent

The mandatory implementation workflow. This skill is the **method**; every
project-specific constraint lives in [`../../rules/`](../../rules/) and is read
at Phase 1, never duplicated here.

## Phase 1: Load the rules

1. Read [`../../rules/architecture.md`](../../rules/architecture.md) — layout,
   layering, dependency direction, structural limits.
2. Read the coding-style rule for the layer you are touching, from
   [`../../rules/`](../../rules/).
3. Read [`../../rules/comments.md`](../../rules/comments.md) — what a comment
   may say and how long it may be.
4. Read [`../../rules/process.md`](../../rules/process.md) — who owns which
   files when more than one agent is on the band, and what you must prove
   before handing over.
5. If a spec exists for the current branch at `.agents/specs/<branch-slug>.md`,
   read it. It is the contract: its acceptance criteria define done, and its
   non-goals define where to stop.

Never infer a convention from surrounding code when a rule states it. Code drifts;
the rules are what the review enforces.

## Phase 2: Design within the constraints

Before writing anything, confirm the change fits:

- **Size and complexity limits** — if the target file is already near its
  ceiling, decompose first, then implement. Retrofitting a split afterwards is
  the expensive order.
- **Layer boundaries** — transport does not hold domain logic; domain code does
  not know about transport; pure layers stay pure.
- **Package boundaries** — cross-package imports go through the package's public
  entry point, never a relative path that climbs out of it.
- **Determinism** — in pure layers, ambient clocks, timers and randomness are
  injected as ports, not called directly.
- **No swallowed errors** — handle, rethrow, log, or write the comment that
  explains why ignoring is safe.

If the change cannot fit the constraints, say so and propose the refactor. Do not
quietly exceed a limit.

## Phase 3: Implement

Prefer decomposing early over refactoring at the ceiling: a second focused file
is always cheaper than one that has to be split later.

Leave nothing unwired. A new module that nothing imports, a handler nothing
routes to, a component nothing renders — these read as complete and are not.
Stage 0 of [`../review/SKILL.md`](../review/SKILL.md) rejects exactly this.

### Names you choose in this phase

A function is named with a verb: a name says what calling it does. `keep`,
`kindOf`, `stamped`, `take` name the answer or nothing at all — `storeFile`,
`detectKind`, `stampSchema`, `handleAndStop` name the act. A predicate may read
as `isPublished`, `hasRight` or `fails`; a bare adjective names a value and
belongs to a `computed`.

Reach for the name before the comment. A docblock written to explain what a
call does is a rename waiting to happen, and the name is read at every call
while the docblock is read only where it is written. The full form of this is
in [`../../rules/coding-style-frontend.md`](../../rules/coding-style-frontend.md),
section 3.

Everything you write is in English — code, comments, test names, the sample
content in stories and fixtures. Russian belongs in `.ftl` bundles and in the
tests that assert what those bundles render.

### Comments you write in this phase

The full rule is [`../../rules/comments.md`](../../rules/comments.md). The four
things it forbids, because they are the four that keep happening:

1. **No identifiers from documents that are not in the repository.** `(D-14)`,
   `(I-2, AC-22f)`, `(T-S-35)` — the plan and the spec are not committed, so for
   the next reader these point nowhere. This includes test names: a test says
   what breaks, not which row of which table asked for it.
2. **No defect history.** What was broken and how it was found belongs in the
   commit message. The docblock describes the code as it stands.
3. **Size matches the subject.** One field gets one line. A non-trivial
   algorithm gets a paragraph. Anything longer is documentation and belongs in
   `docs/`, linked by path.
4. **Say why, not what.** What the code does is the code's job — if a comment is
   needed to explain that, the name is wrong. A comment exists for the constraint,
   the invariant, or the trade-off that the reader cannot see.
5. **All the fields or none of them.** A type whose sixth field carries a
   docblock and whose other five do not reads as if five were forgotten. Either
   the field comments are worth writing for each, or what is worth saying goes
   into the type's own docblock.

## Phase 4: Gatekeeper (strict)

While working, use the narrow gate — the same four stages against the one
workspace you are changing:

```bash
# Go — from the module's own directory; each has its own go.mod
go build ./... && go vet ./... && go test ./... -count=1
golangci-lint run ./...          # what .golangci.yml refuses, past go vet

# mobile / kit / libs — from modules/apps/mobile or modules/kit
npx vitest run && npx vue-tsc --noEmit && npm run lint

# chat — from modules/services/chat/app, the same way CI installs it
uv sync --locked --extra dev
uv run --no-sync python -m pytest tests -q
```

Before reporting the task complete, run the full gate from the repository root,
and the mutation score on what you changed:

```bash
# chat also gates on coverage floors and lint
uv run --no-sync python -m pytest tests -q --cov --cov-report=json
uv run --no-sync python scripts/check_coverage_floors.py
uv run --no-sync ruff check .

# the app on a real device, when the change reaches the Android layer
make native-build && make native     # rebuild first: the suite installs whatever APK is on disk
make e2e                             # Playwright over the mobile web build
```

A fresh worktree needs `git submodule update --init --recursive` and a build of
the in-house plugins before the mobile suite resolves `@kit/*` and
`@shruti/plugin-*`; without them the failures are the environment, not the
change.

**A partial gate is not a gate.** the narrow gate is the inner loop and not a
substitute: a package's own tests say nothing about the packages that import it,
and a change that satisfies one stage routinely fails another — a decomposition
that fixes a line-count violation still has to compile, stay formatted and keep
the rest of the workspace green.

**A green suite is not the same as a tested change.** Break your new code on
purpose and check that something fails. If nothing does, the suite is passing
for a reason unrelated to the behaviour you added.

If any check fails, fix the violation and re-run until the gate exits 0. Report
the result honestly: if something is still failing, say which and why, rather
than describing the task as done.

---
name: package-gate
description: Review Stage 1 — the make check-package claim. Runs the full gate for every package the diff touches plus the architecture gate, then reads the diff against .agents/rules/.
---

# Stage 1: Package Gate

## 1. Run the gates

For every package the diff touches (see "Resolving the target" in
[`../SKILL.md`](../SKILL.md)):

```bash
make check-package PKG=<pkg>
```

and once:

```bash
make check-architecture
```

`check-package` chooses the toolchain from the package: gofmt, go vet,
golangci-lint and `go test -race` for a Go module; ruff, mypy and pytest for
chat; eslint, vue-tsc and vitest for the mobile app and the kit; `astro check`
for the web site. `check-architecture` runs test_layering, depguard,
dependency-cruiser and the gate self-test.

**Reject on the first non-zero exit.** Report the command, the exit code and the
first failing lines. A package's own tests say nothing about its importers: when
a changed package is imported by another (a `libs/*` package, `@lib/contracts`,
`libs/pipeline`), gate the importers too.

## 2. Read the diff against the rules

With the gates green, read the diff against
[`../../../rules/`](../../../rules/). The rules define each item; this is the
list that makes sure each is looked at:

1. **Layers** — does any import point outward, including through a store, a
   composable or a re-export that the tools do not see?
2. **Compatibility** — wire types, SSE events, endpoints, schemas and preference
   keys used by installed clients keep their meaning.
3. **Comments** — against [`comments.md`](../../../rules/comments.md): no
   history, no references to documents outside the repository, proportional
   size.
4. **Names** — verbs for functions, nouns for types, `on<Action>` handlers,
   `use<Feature>` composables.
5. **Presentation vs logic** — no business logic in templates or views; no
   state read from the DOM; no `fetch` in a component.
6. **Cohesion** — one responsibility per unit; no service mixing bounded
   contexts; no handler that routes, validates, persists and notifies at once.
7. **Host-specific values** — no home directories, store paths or host names.

## Output

Stage 1 of the report in [`../SKILL.md`](../SKILL.md).

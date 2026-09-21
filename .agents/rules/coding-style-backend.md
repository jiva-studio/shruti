# Backend (Go) Coding Style & Guidelines

The standards for Go code in lectorium: the nineteen modules under `modules/services/*` (auth, chat's neighbours, ingest, orchestrator, profile, publish-service, discovery, the share-* services, storage-sync, …), `modules/libs/pipeline` and `modules/tools/*`. Each has its own `go.mod` and is built and linted from its own directory. What `.golangci.yml` refuses is the machine-checked half of this file. The architecture these serve is in [`architecture.md`](./architecture.md) and in [`docs/repos/lectorium/`](../../docs/repos/lectorium/README.md).

---

## 1. Module structure

```text
modules/
├── libs/core/            # the hexagon — its own module
│   ├── domain/           # entities, value objects, identifiers, invariants
│   ├── port/             # the interfaces use cases require
│   ├── usecase/          # one business scenario each
│   ├── adapter/          # filesystem, index, agent, cli, mcp, webui, settings, flashcardsui
│   ├── container/        # the composition root
│   └── internal/         # not nameable from outside the module
├── libs/protocol/        # generated from the schema — never hand-edited
└── apps/desktop/         # the window's host: cmd/ and internal/
```

There is no `go.work`. Each module is built and tested from its own directory.

**Identifiers live in `domain/`**: `NoteID`, `VaultID`, `CardFaceID`. Any field named `*Time` in `domain/` or `port/` is a `time.Time` — `MTime` on raw file metadata is the one unix-timestamp exception.

---

## 2. Idiomatic Go

### Context

- `ctx context.Context` is the first parameter of anything that does I/O, touches the database, or runs long. Never stored in a struct.
- Propagated to everything that blocks — a query, a walk, a read.
- Cancellation observed **inside** loops that can run long, not only between them.

### Errors

- Never discarded. `_ = fn()` is a finding.
- Wrapped with `%w` and enough context to locate the failure: `read %s: %w`, not `error: %w`.
- Not both logged and returned. Two lines about one failure is noise at a distance from the cause.
- Sentinels compared with `errors.Is`, types reached with `errors.As`, never string matching. Discriminants are `ErrorCode` and `error`, never `refusal`.
- `panic` only for a programmer error that cannot be recovered from — never for bad input or a missing file.
- Errors from `Close` checked where the write matters, and ignored visibly where it does not.
- **Nothing is logged.** No logging library in the core. An error is returned, reported through `port.Trouble(err)` from a background process, or streamed to the interface.

### Interfaces

- Declared by the code that needs them, not beside the code that satisfies them.
- Small — one to three methods. An interface with one implementation and eight methods is a struct wearing a costume.
- Accepted as parameters, returned as concrete types.
- Not introduced "for testing" when the concrete type is already testable.

### Constructors

- Sealed `New*` constructors that validate every required dependency.
- `New…` for constructors, `make` for built-in allocation. Both are idiomatic here.
- No package-level mutable state, and no `init()` doing work beyond building a constant table.

### Concurrency

- Every goroutine has an owner that knows when it ends, and selects on `ctx.Done()`. One started and forgotten is a leak.
- Shared state guarded, with the guard covering every access rather than most.
- No `time.Sleep` as synchronisation, in code or in a test.
- No blocking channel send without a buffer or a `select` default.
- Everything concurrent is testable under `-race`.

### Resources and data

- `defer` for anything opened. `rows.Err()` checked after iterating. `defer tx.Rollback()` with the commit last.
- SQL parameterised. A query built by string formatting is a finding unless the value cannot be a parameter — a `PRAGMA`, an identifier — and even then it is a constant, never user input.
- `filepath` for the filesystem, `path` for slash-separated data. Stored paths are relative and slashed, so an index built on one platform describes the same file on another.
- A write that must not tear goes through a temporary file and a rename.
- Time injected where it changes behaviour, never read from deep inside.

---

## 3. Naming and API surface

- No stutter: `filesystem.VaultReader`, not `filesystem.FilesystemVaultReader`.
- Functions and methods are imperative verb phrases (`ReadVault`, `WriteNote`) or predicates (`IsStale`, `HasTranscript`). Never third-person singular, never a past participle, never a literary metaphor where a standard engineering term exists.
- Exported identifiers documented, starting with the identifier's own name.
- `internal/` by default; exported only what something outside actually uses.

---

## 4. Comments

A comment states the rule that holds, and stops. It never names an alternative that is not in the code, and never cites an ADR number — restate the rule inline.

Delete each clause in turn: if what remains still describes the code, the deleted clause was argument. Rewrite on sight of `rather than X`, `instead of X`, `so that we do not…`, `otherwise somebody would…`, or any comparison with a previous implementation. Benchmark numbers live in `docs/performance.md`.

---

## 5. Tests

**How this application is tested*.*

- `t.TempDir`, `t.Context`, `t.Cleanup`. Never the machine's real home, config or cache directory, and never the network. Where the code defaults to a platform location, the test passes an explicit path.
- The committed fixture vault in `tests/` is read-only and awkward on purpose. A test that needs to change it works on a copy.
- **A test must be able to fail.** For anything guarding a rule rather than a value, break the rule and watch the test fail — remove the filter, invert the condition, delete the guard. A test that passes either way is worse than no test.
- A scoping claim is tested with two vaults whose notes share no words, asserting both directions.
- Anything configured per connection is tested holding several connections at once; a sequential test is handed the same one every time.
- Table tests where the cases are genuinely parallel, plain tests where they are not.
- Failure messages that say what was wrong: `got %d notes, want 7`.
- New behaviour has a test. A bug fix has a test that fails without the fix.

---

## 6. Formatting & verification

```bash
make lint    # generate-check, gofmt -l, go vet, buf lint, and every window's typecheck
make test    # go test -race in core and desktop, then the interface suites
```

Per module, from its own directory:

```bash
cd modules/libs/core     && gofmt -l . && go vet ./... && go test ./... -race
cd modules/apps/desktop  && gofmt -l ./cmd ./internal && go vet ./... && go test ./... -race
cd modules/libs/protocol && buf lint && npm run generate
```

- `usecase/flashcards` and `adapter/flashcardsui` run close to the ten-minute per-package limit under `-race`. A timeout there is the machine's load — rerun before calling it a failure.
- The schema is never hand-edited. Change the `.proto`, run `make generate`, commit what comes out; `make generate-check` fails when the two drift.
- `node_modules` symlinked from the primary checkout, and `modules/kit` left uninitialised in a fresh worktree, both resolve `@kit/*` to something other than the branch under test. A symbol missing there is that, not the code.

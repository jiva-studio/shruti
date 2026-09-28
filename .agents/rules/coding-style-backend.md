# Backend Coding Style (Go and Python)

The standards for server code in shruti: the Go modules (`modules/services/*`, `modules/libs/pipeline`, `modules/tools/{shruti-mcp,transcriber-*,denoiser-mcp}`) and the Python chat service (`modules/services/chat/app`). Where each package sits and which way its imports point is in [`architecture.md`](./architecture.md). What `modules/.golangci.yml`, `ruff`, `mypy` and `test_layering.py` refuse is the machine-checked half of this file.

---

## 1. Go module structure

```text
modules/services/<name>/
├── go.mod                  # module path: see below
├── cmd/<name>/main.go      # composition root: config, adapters, handlers, server
└── internal/
    ├── domain/             # entities, value objects, invariants
    ├── ports/              # interfaces application needs
    ├── application/<case>/ # one scenario per package
    ├── infra/ store/       # Postgres, Redis, S3, HTTP clients
    ├── handler/            # HTTP transport
    ├── wire/               # request/response types
    ├── config/             # env parsing
    └── logging/            # slog setup
```

Module paths are not uniform; read the module's own `go.mod`. Most services use `github.com/jiva-studio/shruti/<short name>` (`…/auth`, `…/publish` for `publish-service`, `…/pipeline` for `modules/libs/pipeline`); `share-audio`, `share-video`, `social-poster` and `storage-sync` use `github.com/jiva-studio/shruti-<name>`; `shruti-corpus-mcp` and the tools use their repository path (`github.com/jiva-studio/shruti/modules/tools/shruti-mcp`).

Each module is built and tested from its own directory; there is no `go.work`. `modules/libs/pipeline` is shared through a `replace` directive, never copied.

---

## 2. Idiomatic Go

### Context

- `ctx context.Context` is the first parameter of anything that does I/O or runs long. Never stored in a struct.
- Propagated to everything that blocks. Cancellation is observed inside long loops.
- Tests take `t.Context()`, never `context.Background()` (`usetesting` refuses it).

### Errors

- Never discarded. `_ = fn()` on an error is a finding; `errcheck` refuses it.
- Wrapped with `%w` and enough context to locate the failure: `read %s: %w`.
- Logged or returned, not both.
- Sentinels compared with `errors.Is`, types with `errors.As`, never string matching.
- `panic` only for a programmer error, never for input.
- A handler maps domain errors to status codes in one place.

### Interfaces

- Declared by the code that needs them, not beside the code that satisfies them.
- Small. Accepted as parameters, returned as concrete types.

### Constructors and state

- `New*` constructors validate every required dependency.
- No package-level mutable state; no `init()` doing work beyond building a constant table.

### Concurrency

- Every goroutine has an owner that knows when it ends and selects on `ctx.Done()`.
- Shared state is guarded on every access.
- No `time.Sleep` as synchronisation, in code or in a test.
- A read-then-write on shared rows runs in one transaction or behind a unique constraint.
- Everything concurrent is tested under `-race`.

### Resources and data

- `defer` for anything opened; `rows.Err()` checked; `defer tx.Rollback()` with the commit last.
- SQL is parameterised. A query built by formatting is a finding unless the value cannot be a parameter, and then it is a constant.
- A write that must not tear goes through a unique temporary file and a rename.
- Time is injected where it changes behaviour (`internal/clock` or a `Clock` port).

### Naming

- No stutter: `store.Users`, not `store.UserStore`.
- Functions are imperative verb phrases (`VerifyAccess`, `MarkPublished`) or predicates (`IsExpired`).
- `internal/` by default.

---

## 3. Python (chat)

- Python 3.12, `from __future__ import annotations`, full type hints; `mypy` checks attribute and name resolution.
- Absolute imports (`from shruti_chat.domain import …`). `test_layering.py` resolves a relative import to its absolute module and applies the same rules to it.
- Settings are built in `composition.py` and passed down. `test_layering.py` refuses `shruti_chat.config` in `application/` (a shrinking allowlist holds the exceptions); elsewhere it is not checked.
- `async` all the way: no blocking I/O in a coroutine. Background work is owned — a `TaskGroup`, or a task cancelled in `finally` — never a bare `create_task`.
- No `except Exception: pass`. Catch the narrowest exception, and log or re-raise.
- A file replaced on disk uses `tempfile.mkstemp` in the same directory, then `os.replace`, under a lock when more than one writer can reach it.
- Tests use `pytest` with `pytest-asyncio`; Redis through `fakeredis[lua]`. Coverage floors per package live in `pyproject.toml` under `[tool.coverage_floors]`; they ratchet upward and are never lowered.

---

## 4. Tests

- Go: `t.TempDir`, `t.Context`, `t.Cleanup`. Never the machine's real home, config or cache, never the network.
- **A test must be able to fail.** Break the rule it guards and watch it go red.
- A bug fix has a test that fails without the fix.
- Table tests where the cases are genuinely parallel; plain tests where they are not.
- Failure messages say what was wrong: `got %d rows, want 7`.
- A security check has a negative test: the refresh token on an access-only route is refused, an expired token is refused, a foreign account's row is invisible.

---

## 5. Comments

[`comments.md`](./comments.md) applies. A comment states the rule that holds and stops; history belongs in the commit message.

---

## 6. Verification

From the repository root:

```bash
make check-package PKG=modules/services/auth   # gofmt, go vet, golangci-lint, go test -race for one module
make check-go                                   # the same for all nineteen modules
make check-chat                                 # ruff, mypy, pytest for chat
make coverage PKG=modules/services/chat         # pytest --cov and the per-package floors
make check-architecture                         # depguard, test_layering, gate self-test
```

`golangci-lint` is pinned in CI (`modules-go-lint.yml`); use the same version locally. It is looked up on `PATH`, then in `$(go env GOPATH)/bin`, and `GOLANGCI_LINT` overrides both.

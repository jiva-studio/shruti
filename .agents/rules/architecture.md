# Architecture & Repository Guidelines

The architecture of shruti is written down in [`docs/repos/shruti/`](../../docs/repos/shruti/README.md); the mobile app's layering is in [`architecture/layers.md`](../../docs/repos/shruti/architecture/layers.md). This file is the map: where things live, which way the arrows point, and which tool refuses a wrong arrow. When it and a document there disagree, the document wins and this file is the thing to fix.

---

## 1. Monorepo organization

```text
shruti/
├── Makefile                      # every gate and build: make check, check-package, e2e, native, stack-*
├── AGENTS.md                     # entry point for agents; CLAUDE.md imports it
├── .agents/                      # rules, skills, agent roles, task artifacts (.claude links here)
├── docs/repos/shruti/            # architecture, runbooks, API and DB reference
├── infra/                        # compose stacks, Caddy origin, observability
├── scripts/                      # gate drivers: package-gate.sh, check-architecture.sh, mutation suite
├── tests/
│   ├── e2e/mobile/               # Playwright over the mobile web build
│   └── native/android/           # Appium over the real APK on an emulator
└── modules/
    ├── .golangci.yml             # what every Go module is checked for past go vet
    ├── kit/                      # @kit/*: layered TypeScript toolkit (core, servers, ui, infra, persistence)
    ├── libs/
    │   ├── domain/               # @lib/domain: entities, domain services, repository ports
    │   ├── contracts/            # @lib/contracts: wire protocol shared by use cases and adapters
    │   ├── catalog/ chat/ persistence/ ui/   # TypeScript, compiled through the mobile app
    │   ├── pipeline/             # Go: the shared ingest pipeline module
    │   ├── authjwt/              # Go: signs and verifies the auth service's tokens
    │   └── logging/              # Go: slog setup and the log field names
    ├── apps/
    │   ├── mobile/               # Vue 3 + Ionic + Capacitor: the app
    │   └── web/                  # Astro: landing and library site
    ├── services/                 # Go, one module each: analytics, auth, billing, cleanup-worker,
    │   │                         # discovery, ingest, orchestrator, profile, publish-service,
    │   │                         # share-audio, share-video, shruti-corpus-mcp, social-poster,
    │   │                         # storage-sync
    │   ├── share-transcript/     # Python: transcript PDF renderer
    │   └── chat/                 # Python: the agent graph (FastAPI + LangGraph)
    ├── plugins/                  # in-house Capacitor plugins: audio-player, media-downloader
    └── tools/                    # local tooling: shruti-mcp, transcriber-*, denoiser-*, screenshots,
                                  # adv, gate-fixtures
```

There is no `go.work`. Each of the twenty-one Go modules (`modules/services/*`, `modules/libs/{pipeline,authjwt,logging}`, `modules/tools/{shruti-mcp,transcriber-service,transcriber-mcp,denoiser-mcp}`) is built, tested and linted from its own directory; `make check-package PKG=<dir>` does that for one, `make check-go` for all.

The TypeScript libraries under `modules/libs/` are reached from the mobile app through `modules/apps/mobile/submodules/*` symlinks and tsconfig aliases (`@lib/domain`, `@lib/contracts`, `@lib/ui/*`, `@lib/chat/*`, `@lib/catalog/*`, `@lib/persistence/*`). They have no toolchain of their own; `make check-mobile` compiles, lints and tests them.

## 2. Production and what may break

Production is the mobile app and the services. Installed clients hold a local SQLite database, sync cursors, an outbox and issued tokens, and they keep running old builds for months. Wire contracts, SSE events, endpoints, database schemas and preference keys are never removed and never change meaning. The MCP servers and `modules/tools/*` run locally and may change freely.

## 3. Dependency flow

### Go services

A service that is layered uses `internal/` like this:

| Package | Holds | May import |
|---|---|---|
| `internal/domain` | entities, value objects, invariants | the standard library, other `domain` |
| `internal/ports` | interfaces the application asks through | `domain` |
| `internal/application` | one business scenario per package | `domain`, `ports` — never a driver (`pgx`, `redis`, `database/sql`) |
| `internal/infra`, `internal/store` | driven adapters: Postgres, Redis, HTTP clients, S3 | `domain`, `ports` |
| `internal/handler` | HTTP transport: decode, call application, encode | `application`, `domain`, `wire` |
| `internal/wire` | request and response types that cross the network | nothing internal |

`discovery`, `ingest`, `orchestrator`, `publish-service` and `storage-sync` follow this shape. `auth`, `billing`, `profile` and the smaller services are organised by feature (`service/`, `store/`, `handler/`, `jwt/`) and are being moved onto it; a new package in them takes the layered shape. `modules/libs/pipeline` is a library with its own `ports/`; it, `modules/libs/authjwt` (the one token verifier) and `modules/libs/logging` (the one slog setup) are imported through `replace` directives.

**Enforced by** depguard in [`modules/.golangci.yml`](../../modules/.golangci.yml), run in every module by `make check-architecture`.

### Mobile app and TypeScript libraries

The layers, the aliases and what each may import are in [`layers.md`](../../docs/repos/shruti/architecture/layers.md). In short, inward only:

- `@lib/domain` imports the shared kernel (`@kit/core`, `@kit/servers`) and nothing else.
- `@usecases` imports `@lib/domain` and the shared kernel (`@kit/*`, `@lib/contracts`); never `@ports`, `@infra`, `@ui`, `@shruti`, `@lib/persistence`, `vue` or a platform API.
- `@ports/app` imports the shared kernel only.
- `@infra/*` implements ports; it imports `@ports/app`, `@lib/domain`, `@lib/contracts`, `@lib/persistence/*`, `@kit/*`, `@shruti/plugin-*`, and never `@ui`, `@usecases` or a sibling `@infra/*`.
- `@ui/*` is humble: `vue`, `@ionic/vue`, lower UI sub-layers. Never `@ports`, `@infra`, `@lib/domain`, `@usecases`, `@shruti/*`. A component that needs a domain shape declares a mirror type.
- `shruti/` is the composition root and the driving adapters (views, router, stores, composables). Views reach adapters through use cases and stores, never `@infra` directly.
- `@lib/ui` knows no domain: no `@lib/domain`, `@lib/contracts`, `@lib/catalog`, `@lib/persistence`, `@ionic`.

Imports are aliased (`@lib/*`, `@usecases`, `@infra/*`, `@ui/*`, `@kit/*`); a relative path never climbs out of its package.

**Enforced by** dependency-cruiser (static, multi-line, dynamic and relative imports) and the `no-restricted-imports` / `no-restricted-syntax` blocks in `modules/apps/mobile/eslint.config.js`.

### Chat service (Python)

`modules/services/chat/app/src/shruti_chat/`: `domain/` (entities, ports, value objects) is innermost; `application/` orchestrates ports and never imports `infra`, `api`, `indexer`, `composition`, `research` or a driver; `research/` mirrors `application/`; `infra/` holds driven adapters and imports only `domain/`; `agent/` is the LangGraph runtime (only `agent/graph/` imports `langgraph`, only `agent/llm.py` imports `litellm`); `api/` is transport; `composition.py` wires it. Settings reach a layer through composition, never by importing `shruti_chat.config`.

**Enforced by** [`tests/test_layering.py`](../../modules/services/chat/app/tests/test_layering.py): directional rules with allowlists that may only shrink, no relative imports, and a ratchet on the package cycle.

### Everything

Libraries never depend on applications or services. Services never import each other's code; they talk over HTTP, Redis streams or the published catalog database (`db-scheme.json`).

## 4. Gates prove themselves

Every layer gate has a known-violation fixture in [`modules/tools/gate-fixtures/`](../../modules/tools/gate-fixtures/manifest.json), and `make check-architecture` fails if a gate stops refusing its fixture. A new class of violation is fixed together with its fixture; a fix without a gate does not count.

## 5. Ports and adapters

- A **port is named after the need**, an **adapter after the technology**.
- **Interfaces belong to whoever needs them.** The consumer declares the interface; the implementation does not name it.
- **Driving and driven adapters are both adapters.** A handler, a view and an MCP server drive the core; a database, a filesystem and a clock are driven by it.
- **A use case is one business scenario** and owns the boundary of one unit of work — which is where a transaction belongs.
- **A repository is a collection**: put an aggregate in, take one out, remove one. Searches and counts are queries beside it.
- **Entities hold rules, not the world.** No I/O, no clock, no framework tags, no knowledge of storage.
- **A handler never returns a storage row**; it maps to the `wire` type.

## 6. Determinism

In a pure layer — Go `domain`/`application`, `@lib/domain`, `@usecases`, `@ports`, chat `domain/`:

- **The clock is a port.** `time.Now()`, `Date.now()`, `new Date()`, `setTimeout`, `setInterval` are injected.
- **Randomness is a port.** `math/rand`, `Math.random()` are passed in or seeded. Anything security-sensitive comes from `crypto`.
- **No error is swallowed.** An empty `catch {}`, an `except Exception: pass` and a discarded `_ = fn()` are forbidden. An error is handled, returned, wrapped, or ignored with a comment saying why that is safe.

## 7. Nothing exists that no decision asked for

Every field parsed, column stored and option offered answers a decision. Do not abstract before there is a second case, and do not leave a genuinely needed seam missing. Dead code is deleted, unless it is a production contract (a route, an SSE event, a wire field, a column, a preference key).

## 8. Size is not a rule

A file is split when it holds a second responsibility — a section with its own state, a part rendered on its own elsewhere, a concern that can be exercised separately. Line counts, import counts and block sizes are never a review finding. A folder that collects a kind rather than a thing (every entity in one file, every use case in one package) is.

## 9. Nothing host-specific is committed

No home directories, nix store paths, host names or personal wrappers. A host-specific helper is preferred-if-present, never required, and every default is overridable by an environment variable.

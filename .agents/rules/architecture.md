# Architecture & Repository Guidelines

The architecture of lectorium is written down in [`docs/repos/lectorium/`](../../docs/repos/lectorium/README.md), and the mobile app's layering in [`architecture/layers.md`](../../docs/repos/lectorium/architecture/layers.md). This file is the map: it says where things live and which way the arrows point. When it and a document there disagree, the document wins, and this file is the thing to fix.

---

## 1. Monorepo organization

```text
lectorium/
├── Makefile                      # every gate and build: make e2e, make native, the mcp and stack targets
├── docs/repos/lectorium/         # the architecture, the runbooks, the API and DB reference
├── tests/
│   ├── e2e/mobile/               # Playwright over the mobile web build
│   └── native/android/           # Appium over the real APK on an emulator
└── modules/
    ├── .golangci.yml             # what the Go modules are checked for past go vet
    ├── kit/                      # git submodule: @kit/* primitives shared between apps
    ├── libs/                     # TypeScript shared by the apps
    │   ├── domain/               # entities and pure domain services
    │   ├── contracts/            # what crosses the network boundary
    │   ├── catalog/ chat/ persistence/
    │   ├── ui/                   # Vue 3: components that know nothing about the domain
    │   └── pipeline/             # Go: the shared ingest pipeline module
    ├── services/                 # Go, one module each: auth, ingest, orchestrator, profile,
    │   │                         # publish-service, discovery, share-*, storage-sync, billing…
    │   └── chat/                 # Python: the agent graph (its own layering guard in tests)
    ├── apps/
    │   ├── mobile/               # Vue 3 + Ionic + Capacitor — the app
    │   └── web/                  # Astro — the landing and library site
    ├── plugins/                  # in-house Capacitor plugins: audio-player, media-downloader
    └── tools/                    # Go and Node tooling: the MCP servers, screenshots, transcriber…
```

There is no `go.work`. Each Go module — `libs/core`, `libs/protocol`, `apps/desktop`, `apps/mobile` — is built and tested from its own directory, which is what the Makefile targets do.

## 2. Dependency flow

- **Libraries never depend on applications.** `modules/libs/*` is what `modules/apps/*` is built from, never the reverse and never sideways.
- **`core` points inward.** `domain/`, `port/` and `usecase/` import nothing from `adapter/`, and nothing that is a driver, a framework or a transport. The compiler proves it: the violation is always visible in an import block.
- **`ui` knows nothing about the domain.** No component or fixture in `modules/libs/ui` or `@kit/ui` imports `@lib/contracts`, a wire type, a domain type, or anything under `modules/apps/**`. A fixture taken from the domain is how the dependency comes back in through the door marked "tests".
- **`protocol` is generated, not written.** What crosses between the Go host and a window is the schema's shape; `make generate-check` fails when what is committed is out of date (*A client is generated from the protocol*).
- **An application is where the two sides meet.** `modules/apps/desktop` translates the domain into the drawing vocabulary a component takes, and translates the identifier a component emits back.

## 3. Ports and adapters

**A hexagonal core in Go*.*

- A **port is named after the need**, an **adapter after the technology**. The core asks for somewhere to read a vault from; that the answer is a filesystem, and that the index is SQLite, is knowledge confined to `adapter/` and `container/`.
- **Interfaces belong to whoever needs them.** The consumer declares the interface; the implementation never names it. An adapter importing the port package to announce it satisfies it is ceremony.
- **Driving and driven adapters are both adapters.** A CLI, a window and an MCP server drive the core; a database, a filesystem and a clock are driven by it. The core must not be able to tell which is on the other side.
- **A use case is one business scenario**, and it owns the boundary of one unit of work — which is where a transaction belongs.
- **A repository is a collection**: put an aggregate in, take one out, remove one. Searches and counts are queries beside it, not methods on it.
- **Entities hold rules, not the world.** No I/O, no clock, no framework tags, no knowledge of how they are stored.

## 4. The interface hexagon

**How an interface component is built*, *The component library is shadcn-vue*.*

The same split runs through the component library:

- **The core is pure.** Given the props it computes what is to be drawn — every coordinate, state and derived flag — as plain values, with no DOM, no Vue, no clock, no randomness and no measurement of text.
- **The view is humble.** It turns those values into elements and works nothing out. A number in a template that the pure core did not produce is a broken split.
- **Anything with a lifetime is a port**: the clock, `requestAnimationFrame`, the viewport, the motion preference. Each is a parameter with a browser-shaped default, so the component works with no ceremony in an application and is fully determined in a test.
- **Styling is design tokens, and only design tokens**, declared on the root alone in `src/tokens/`.

## 5. Determinism

In anything pure — `domain/`, the model and arithmetic modules beside a component, the text cutting and chunking:

- **The clock is a port.** `time.Now()`, `Date.now()`, `new Date()`, `setTimeout` and `setInterval` are injected, never reached for. Time has a lifetime a test must control.
- **Randomness is a port.** `math/rand` and `Math.random()` are passed in or seeded.
- **The same input gives the same output** on any machine on any day. A chunk identified by its text is the same identifier on either platform (*A chunk is identified by its text*).
- **No error is swallowed.** An empty `catch {}` and a discarded `_ = fn()` are both forbidden. An error is handled, returned, wrapped, or ignored with a statement saying it is.

## 6. One name for one thing

*The glossary preamble.*

The domain, the storage, the wire and the interface use one word for one thing. **A word means one thing inside its context, and the same word in two contexts is not a collision** — nothing is renamed to keep clear of a name another context already uses, and a word is listed as never called something only where the two would genuinely be taken for the same thing.

A concept takes the word its field already gives it. A field renamed on the way across a boundary is a defect unless the glossary lists the rename; it lists `calling`/`doing` and `stretch`/`span`, each a rename the boundary requires, and a third name for either is the defect.

A concept appearing in code under a name nobody wrote down is the point at which the code and the documents start describing different systems. A new term is added to the glossary in the change that introduces it.

## 7. Nothing exists that no decision asked for

For every field parsed, column stored, syntax accepted or option offered there is a decision that wants it. A parsing rule nobody specified was invented by whoever wrote it, and once a vault is full of what it accepts, the guess is permanent. This applies most to things that look free: a tag, an extra frontmatter key, a convenience flag.

Equally: do not abstract before there is a second case, and do not leave a genuinely needed seam missing.

## 8. Size is not a rule

A file is split when it holds a second responsibility — a section with its own state, a part rendered on its own elsewhere, a concern that can be exercised separately. Line counts, import counts and block sizes are not limits here and are never a review finding. What is a finding is a folder that collects a kind rather than a thing: every entity in one file, every use case in one package, readable at five and unreadable at fifty.

# Shruti mobile E2E tests

End-to-end tests that drive the mobile web app through **real user gestures**
(tab taps, list taps, the search box, the add-to-playlist button) with
Playwright and assert behaviour — not pixels.

Specs carry tags on two axes, and titles read `area · behaviour` so the report
groups naturally.

**Execution tag** (which server/report project):
- **`@offline`** — deterministic, fast, no backend (intercepted fixtures). Runs in
  the `mocked` project. This is what `npm test` runs.
- **`@live`** — drives the real backend (local stack: chat + auth). Runs in the
  `stack` project via `npm run test:live` (needs the stack up — see "Live tier").

**Area tag** (which part of the app): `@home` · `@library` · `@player` ·
`@transcript` · `@notes` · `@settings` · `@chat`. Filter with e.g.
`npx playwright test --grep @chat` to run every chat journey across both tiers.

One run, one report: `npm run test:all` runs `mocked` + `stack` into a single
`playwright-report/` (open with `npm run report`).

### `@offline` journeys

| Spec | Journey |
| --- | --- |
| `launch` | app boots past Welcome to a populated Home |
| `launch-locale-chunk` | a boot-locale chunk that fails to load still yields a usable app |
| `search` | the library search box filters the catalog list |
| `track-card` | tapping a track opens its detail card |
| `add-track` | adding from the card grows the playlist |
| `delete-track` | swipe-delete shrinks the queue |
| `play` | tapping a queued track activates the player |
| `transcript` | starting a track reveals its transcript |
| `notes` | the Notes tab lists the saved bookmarks |
| `settings` | flipping a setting changes app behaviour |
| `library-language` | the library content language seeds + filters the catalog per locale |
| `topic-language` | a topic lists only lectures in the library language |
| `collection-language` | a collection lists only lectures in the library language |
| `settings-library-language` | the Settings library-language picker re-filters discovery |
| `settings-language-race` | two quick UI-language switches settle on the one picked last |
| `settings-language-failure` | a UI language whose chunk fails leaves the setting where it was |
| `chat-render` | the chat composer + suggestions render |
| `share-menu` | the track share menu offers a PDF export |

### `@live` journeys (need the local stack)

| Spec | Journey |
| --- | --- |
| `chat-send.live` | send a chat message → receive a streamed reply |

## How it works

The app needs a catalog DB and a user DB to run, and bounces to `/welcome`
otherwise. Rather than click through onboarding, `support/bootstrap.ts` reuses
the screenshot pipeline's recipe:

- **Network interception** — `**/public/config.json` and the catalog
  `**/public/db/shruti.*.db` are fulfilled from `fixtures/` so the app comes
  up offline and deterministically; `**/public/tracks/*/audio/*` is served a
  real ~1s silent MP3 so playback genuinely starts.
- **IndexedDB pre-seed** — `fixtures/user-<locale>.db` (a seeded user with ~9
  playlist tracks, history and notes) is written into IndexedDB before boot.
- Transcript JSONs are served from `fixtures/transcript.json`, rewritten to
  match the requested track so the reader renders offline.
- **Cover art** (`support/assets-mock.ts`) — collection and topic covers are
  served the fixture PNG. Unserved they died against the sink, and every tile
  fell back to its no-cover tint, so a cover assertion passed whether or not the
  plumbing worked. A spec that owns the cover route itself registers it before
  `boot` and passes `{ covers: false }`.
- **The internet lane** (`support/discovery-mock.ts`) — `**/discovery/search`
  answers two hits by default. `installDiscoveryMock(page, …)` replaces that per
  spec with other hits, the service's `messages`, an empty result or a failure,
  and can record the request bodies the app sent.

### Staying offline

The `@offline` tier must never touch a real backend. Four things enforce that,
all automatic — nothing to opt into per spec:

- **A sink region.** The mocked `config.json` carries a `regions` block whose
  every service URL (`urlTemplate`, `authBaseUrl`, `chatBaseUrl`,
  `profileBaseUrl`, `orchestratorBaseUrl`, `discoveryBaseUrl`, `share*Url`)
  points at `http://127.0.0.1:11098` — a port nothing listens on. Without it
  `startup.ts` returns early on `if (!config.regions)` and the app keeps its
  compiled-in `SERVERS`, whose `global` region is **production**.
- **A network guard** (`support/network-guard.ts`) blocks every request that
  would leave the machine, and *fails the test* when it was aimed at a
  production host — naming the URL and the spec.
- **`POST /auth/anonymous`** is answered with a canned session for every spec,
  so no run can mint a real account. `/auth/me` and `/auth/refresh` stay
  opt-in: they describe *which* session a spec seeded.
- **`**​/profile/sync/*`** is answered with an empty pull and an accepting
  push, so the sync engine — which runs for anonymous users too — has a
  deterministic local answer.

Those route sets are registered on the browser **context**, which Playwright
matches after page-level routes, so a spec's own `page.route` still wins.

Set `E2E_NET_LOG=<file>` to append a JSONL record of every blocked outbound
attempt — that is how the leak is measured.

Everything is driven through the rendered UI; the suite never touches the
`window.__shruti.debug` bridge (the screenshot pipeline does). That bridge
isn't compiled into the production/CI bundle, so depending on it would make the
tests un-runnable in `bundle` mode.

## Running locally

Turnkey (a `Makefile` wraps everything — brings the stack up when needed):

```bash
cd tests/e2e/mobile
make install     # one-time: deps + chromium + fixtures
make test        # offline suite (fast, no backend)
make all         # offline + live (auto-starts the local stack) → one report
make report      # open the HTML report (a video per test)
```

Or directly:

```bash
npm install
./scripts/prepare-fixtures.sh   # one-time: seed the gitignored user DBs
npm test                        # offline   (or: npm run test:headed)
./scripts/run-all.sh            # offline + live (auto-starts the stack)
```

`npm test` boots a Vite dev server on `E2E_PORT` (default 11097) and runs the
`@offline` specs against it. A system Chrome is auto-detected; set `CHROME_PATH`
to override.

Every run records a **video of each test** and writes the HTML report to
`playwright-report/`; open it with `npm run report` to watch what each test did.

## Live tier (`@live`)

These run against a real local backend instead of mocks — needed for chat
send/receive (and, later, auth / PDF). The app is served with
`VITE_DEV_REGION=true` so it points at the local stack (`localhost:11080` chat /
`:11081` auth) while content still loads from the prod CDN.

```bash
./scripts/live-up.sh             # make stack-setup (first run) + stack-up + wait /readyz
npm run test:live                # playwright.live.config.ts → @live specs
```

`live-up.sh` needs, in `../../../infra/app/.env.dev`: `OPENROUTER_API_KEY` (chat
can't answer without it — `/readyz` stays false), `AWS_*` (corpus indexing), and
a `SHRUTI_TS_IP` (only the search-mcp service; a dummy is fine). For grounded
answers, seed a **small curated corpus** via the chat service's index/import
path; an empty corpus still streams an ungrounded reply, enough for the
send/receive smoke test.

> **Worktree note** — when running from a `git worktree`, the mobile app needs
> its `node_modules` and the `modules/kit` submodule. Symlink both from a fully
> set-up checkout, e.g.
> `ln -s <main>/modules/apps/mobile/node_modules modules/apps/mobile/node_modules`
> and `ln -s <main>/modules/kit modules/kit`.

## CI

Two CI paths run this suite:

- **`e2e (manual)` workflow** (`.github/workflows/e2e.yml`) — **the real run**.
  Trigger it from the Actions tab (`workflow_dispatch`). It builds the in-house
  plugins, prepares the fixtures (`prepare-fixtures.sh` seeds the user DBs; the
  catalog is committed), installs Chromium, and runs the full suite against the
  Vite dev server. Kept manual on purpose — it boots the app, so it's heavier
  than the unit jobs and not worth gating every push on.

- **kit reusable `e2e` job** (auto, on mobile PRs) — a **no-op**. It activates
  because `package-lock.json` is committed, but every spec SKIPS when the
  fixtures aren't prepared (`support/test.ts`), so it stays green without doing
  real work. (`E2E_USE_BUNDLE=1` would make `playwright.config.ts` serve the
  prebuilt `dist/` via `vite preview` instead of the dev server.)

Follow-up before the auto job does real testing: run `prepare-fixtures.sh` in
it. The catalog no longer stands in the way — it is committed — so all that is
missing there are the seeded user DBs.

## Fixtures (`fixtures/`)

Committed (the corpus every spec runs against is pinned, so a run on one branch
is comparable with a run on another):

- `content.db` — a trimmed catalog, ~1000 lectures carved out of a published
  snapshot. `content.db.json` records the snapshot it came from, its digest and
  the row counts.
- `silent.mp3` / `cover-sample.png` / `transcript.json` — small media stubs.

Rebuilt locally, gitignored:

- `user-en.db` / `user-ru.db` (+ `.clean` / `.single`) — seeded user DBs from
  the screenshot pipeline's generator
  (`modules/tools/screenshots/generate-fixtures`). Their listening history is
  anchored to the local midnight of the day they were generated — the activity
  heatmap reads the real clock — so they are generated, not committed. Within a
  day two runs produce byte-identical files; nothing else in the generator reads
  the clock.

`./scripts/prepare-fixtures.sh` builds the user DBs and verifies `content.db`
against its recorded digest. It touches no network.

### Moving the catalog fixture

The catalog fixture only changes when someone decides it should, in a commit
that can be reviewed:

```bash
scripts/build-catalog-fixture.py --source path/to/shruti.<version>.db
git add fixtures/content.db fixtures/content.db.json
```

`--source` defaults to the local lake output
(`resources/lake-out/artifacts/catalog/current.db`), but prefer a
version-addressed published catalog — `public/db/shruti.{version}.db` is
immutable per version, so the build is reproducible from what the metadata
records.

The trim is not just a size cut. The Search landing shuffles its topic tiles, so
a spec that opens "the first tile" opens a *random* topic; against the full
catalog whether that topic holds lectures in the library language depends on
what was published, and Qase 36/45/150/163 then pass or fail on the draw. The
builder keeps only topics carrying lectures in **both** content languages and
asserts that (plus per-language title script, non-empty collections, and the
tracks the seeded playlists reference) before it writes the file.

# Development environment

Day-to-day Shruti development is the Ionic + Vue mobile app talking to
the public CDN — core browsing, playback, reading and the prebuilt SQLite
catalog all work with **no local backend at all**. The online features
(AI chat, auth, share-clip generation) are backed by a small set of
services that you *can* bring up locally on demand with a docker-compose
stack (`make stack-*`); you only need it when working on those features
or running the `@live` E2E tests. Everything is driven from the root
`Makefile`.

## Quick reference: `make` targets

The repo root has a `Makefile` wrapping every common command. Run `make help` from `source/shruti/` for the full list; below is the daily subset.

| Group | Common targets |
|---|---|
| Mobile dev | `make mobile-install` (first time), `make mobile`, `make mobile-build`, `make mobile-deploy`, `make mobile-live ISSUE=N` |
| iOS | `make mobile-build-ios`, `make mobile-upload-ios` |
| Screenshots | `make mobile-screenshots-android`, `make mobile-screenshots-ios` |
| Content DB | `make db-sync` (default: all), `make db-sync TARGET=android\|ios\|e2e\|all` |
| Worktrees | `make worktree-create ISSUE=N`, `make worktree-serve ISSUE=N`, `make worktree-serve-bg ISSUE=N`, `make worktree-list`, `make worktree-remove ISSUE=N` |
| Local stack | `make stack-setup` (first time), `make stack-up` / `-down` / `-restart` / `-status` / `-logs`, `make stack-app` |
| E2E | `make e2e-install`, `make e2e` (offline), `make e2e-all` (offline + live), `make e2e-report` |
| Services | `make transcriber-up` / `-down` / `-status` / `-logs`, `make shruti-mcp-up` / `-down` / `-status` / `-logs` |

*Full list: `make help` from the repo root.*

## Mobile app

Workspace: `modules/apps/mobile/`.

```bash
cd modules/apps/mobile
npm install
npm run dev          # Vite dev server (default port 11001)
```

| Script | Purpose |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run dev:screenshots` | Dev server with `VITE_DEBUG_API=true` on port 11001 (used by the screenshots tooling) |
| `npm run build` | `vue-tsc` + Vite production bundle |
| `npm run build+sync` | Build, then `npx cap sync` to push the web bundle into the Android/iOS Capacitor projects |
| `npm run preview` | Serve the production bundle locally |
| `npm run lint` | ESLint |
| `npm run test` / `npm run test:watch` | Vitest |
| `npm run typecheck` | `vue-tsc --noEmit` |
| `npm run assets:generate` | Regenerate icons / splash via `@capacitor/assets` |

By default the web build (`npm run dev`) talks to the same public CDN as
the production app — so no special data setup is needed to develop UI or
business logic. To point auth + chat at the **local stack** instead, use
`make stack-app` (it runs `npm run dev` with `VITE_DEV_REGION=true`, which
selects the dev region pointing at the localhost services). For native
builds open `android/` in Android Studio or `ios/App/App.xcworkspace` in
Xcode after running `build+sync`. Debug-APK and signed-IPA builds go
through Fastlane (`make mobile-build`, `make mobile-build-ios`).

## Content database

The app ships a prebuilt SQLite catalog. You don't build it locally —
`make db-sync` downloads the latest scheme-compatible DB straight from
the public CDN and copies it into the platform projects:

```bash
make db-sync               # all targets (android, ios, e2e)
make db-sync TARGET=android
```

The wrapper (`modules/db-sync.sh`) is thin: it exports Shruti's app
name, CDN URL, scheme file and dist targets, then delegates all the sync
logic to the shared kit script (`modules/kit/scripts/db-sync.sh`). It
reads the supported scheme version from `modules/db-scheme.json` (key
`scheme`, the single source of truth — also consumed by the mobile Vite
config at build time), queries the CDN config (`public/config.json`) for
the highest matching DB under `public/db/`, caches it under
`modules/.db-cache/`, and drops it into the platform DB folders:

- Android — `modules/apps/mobile/android/app/src/main/assets/databases/`
- iOS — `modules/apps/mobile/ios/App/App/databases/`
- E2E — `tests/e2e/mobile/fixtures/public/db/` (plus the fixture `config.json`)

Stale `shruti.*.db` files in each target are removed so lexicographic
pickup stays correct.

The DB itself is produced and published by the `shruti-mcp`
`catalog.publish` flow, not by anything in this repo's build. See
[`./storage.md`](./storage.md) for the bucket / publishing side.

## Local backend stack

The online features run as a docker-compose stack you can bring up
locally. The compose files live in `infra/app/compose/`
(`docker-compose.yml` + `docker-compose.dev.yml`); the `stack-*` Make
targets wrap a canonical invocation that pins the project name
(`shruti`), the `origin` compose profile, the file set and the
`infra/app/.env.dev` env file:

```make
STACK_COMPOSE = COMPOSE_PROFILES=origin docker compose -p shruti \
    -f docker-compose.yml -f docker-compose.dev.yml --env-file ../.env.dev
```

Because the invocation selects `COMPOSE_PROFILES=origin`, `make stack-up`
brings up the whole `origin` profile: Postgres, Redis, the `migrator`,
`chat` (Python), `auth` (Go), the `cleanup-worker`, plus `share-audio`,
`share-video` and `share-transcript`. The dev overlay restores `build:`
blocks (with `pull_policy: never`) so those build from local source — no
GHCR token needed. (`search-mcp` is also `origin`-profiled but has no
dev build block, so a plain `stack-up` would try to pull its private
image.)

```bash
make stack-setup     # first time: gen .env.dev + JWT keys + npm install
make stack-up        # build + start all services
make stack-status    # containers + chat /readyz
make stack-app       # serve the mobile app against the local stack
make stack-down      # stop (keeps pg/redis volumes)
```

`make stack-setup` runs `infra/app/scripts/gen-dev-env.sh` (writes
`infra/app/.env.dev` with `SHRUTI_`-prefixed vars, idempotent) and
`infra/app/scripts/gen-jwt-keys.sh`, then installs the mobile npm deps.
Host ports land in the 11xxx band: chat `11080`, auth `11081`, Postgres
`11082`, Redis `11083`, share-audio `11084`, share-transcript `11085`
(each overridable via the matching `SHRUTI_*_PORT` var). `migrator`,
`cleanup-worker` and `share-video` expose no host port.

## End-to-end tests

The Playwright mobile E2E suite lives in `tests/e2e/mobile`. Offline tests
need no backend; the `@live` tests auto-start the local stack.

```bash
make e2e-install     # one-time: deps + chromium + fixtures
make e2e             # offline only (fast)
make e2e-all         # offline + live (auto-starts the stack)
make e2e-report      # open the HTML report (a video per test)
```

## Worktrees

For working multiple issues in parallel, the `worktree-*` targets create
git worktrees under `../.worktrees/issue-<N>` on branch `feature/<N>`
(override with `BRANCH=`), each on its own dev-server port
(`11100 + N`).

```bash
make worktree-create ISSUE=42   # add worktree + npm ci
make worktree-serve  ISSUE=42   # dev server on port 11142
make worktree-list              # active worktrees + ports
make worktree-remove ISSUE=42   # remove worktree (keeps the branch)
```

`make mobile-live ISSUE=42` builds and installs an APK wired for Capacitor
live-reload against the worktree's dev server (host IP + port `11142`).

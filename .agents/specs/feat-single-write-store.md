# Task Specification: One write store, one backend, retire the `proxy` role

**Branch / Worktree**: `feat/single-write-store` (stacked on `feat/edge-role`)
**Status**: `COMPLETED`
**Target Modules**: `modules/services/share-audio`, `modules/services/share-video`, `modules/services/share-transcript`, `modules/services/social-poster`, `modules/tools/shruti-mcp`, `modules/libs/domain`, `infra/app`, `infra/tests`, `docs/repos/shruti`

---

## 0. Prior art

- [bunny.net — Edge Storage HTTP API](https://docs.bunny.net/api-reference/storage):
  objects are `GET`/`PUT`/`DELETE` at `{endpoint}/{zone}/{path}` with an `AccessKey` header; a `GET` on a path ending in `/` lists that directory (one level, JSON array with `ObjectName`, `IsDirectory`, `Length`). There is no custom object metadata and no presigning.
- [Amazon S3 — one-way replication rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mrap-create-one-way-replication-rules.html):
  one-way replication is the recommended shape when readers only consume the destination; two-way replication is only for destinations that users also write to.
- [Asynchronous replication — primary is the source of truth for new writes](https://www.ituonline.com/tech-definitions/what-is-asynchronous-replication/):
  commit locally, ship to the secondary afterwards; the price is a replication lag window, the gain is a single writer.
- [Martin Fowler's Tolerant Reader, as summarised by java-design-patterns](https://java-design-patterns.com/patterns/tolerant-reader/):
  a consumer reads only what it needs and ignores what it does not know — the provider can add fields without breaking it.
- [Round-trip JSON through a partial Go struct](https://prashantv.com/posts/json-partial-go/) and [golang/go#22533](https://github.com/golang/go/issues/22533):
  `encoding/json` drops unknown fields; the established fix is to keep the raw object (`map[string]json.RawMessage`) beside the typed view and write the known fields back into it on marshal.

**Adopted**: every service writes to exactly one store (the Bunny storage zone) and the mirror is filled one way by `storage-sync`; the tool that edits `config.json` regions round-trips every field it does not model.
**Rejected**: (a) keeping per-region writers to the mirror — it is two-way replication by another name, with two stores that can disagree about a share URL; (b) modelling every current region field in the Go struct and nothing else — it strips the next optional field the app adds, which is the defect this branch fixes.

---

## 1. Business Context & User Value (JTBD)

### Problem Statement & Trigger
- **Trigger**: the regional host is moving from the `proxy` role (local share-* writing to the S3-compatible mirror) to the stateless `edge` role, which forwards every `/share/*` call to origin.
- **Pain Point**: the share services still carry an S3 client whose default endpoint is a bucket that no longer exists, share-transcript cannot talk to the write store at all, the MCP publishes to three targets of which one is dead and one is a mirror that `storage-sync` already fills, and `catalog.config.regions.upsert` silently strips `shareTranscriptUrl` and `discoveryBaseUrl` from every region it touches.
- **Current Workaround**: operators set per-host S3 overrides and hand-edit `config.json` after an upsert.

### User Journey & Workflow (Before vs After)
- **Before**: a share request on a regional host is handled locally and written to the mirror; on origin the same service may default to a dead bucket; an operator upserting a region loses two fields.
- **After**: every share request is handled on origin and written to the one store; the mirror follows through `storage-sync`; region edits keep every field.

### Value & Success Criteria
- **Primary Value Delivered**: one place where an object is written and one place a share URL points at; no configuration path that reaches a dead store.
- **Observable Verification**: each share service refuses to start without its Bunny credentials and public base; `caddy adapt` for origin is unchanged; an upsert over a region with unknown fields keeps them.

---

## 2. Goals, Non-Goals & Scope Guardrails

### In-Scope Goals
- share-audio, share-video, share-transcript: Bunny is the only backend for reads and writes; the S3 client, endpoint override and AWS-default URL paths are deleted.
- shruti-mcp: Bunny is the only publish target; AWS/Yandex uploaders and config removed; regions round-trip every field.
- Remove the `proxy` role from Caddy, compose, `deploy.sh`, `.env.example`, README and docs.
- Mobile bundled seed: drop the `legacy` region, put the regional seed's storage on its own host.
- social-poster example config: drop the regional share-audio.

### Non-Goals
- `infra/app/scripts/backup.sh` (tracked separately).
- `ingest` and `publish-service` storage backends (they already select Bunny through `SHRUTI_STORAGE_BACKEND`; retiring their `s3` branch is its own change).
- `storage-sync` and its mirror configuration (`YC_*`/`YANDEX_*`) — unchanged.
- The edge role itself, origin's routing, rate limits and headers.
- The published `config.json` (an ops step, not code).

### Decisions
| Question | Decision | Why |
| :--- | :--- | :--- |
| share-audio source reads | ffmpeg keeps reading the source through the pull-zone URL (`EXCERPTS_PUBLIC_BASE` + key) | Sources live under `public/tracks/`, which the pull zone serves from the same storage zone the service writes to; ffmpeg range-reads only the bytes around the cut. No S3 endpoint is involved. The unused `DownloadTo` is deleted. |
| share-video background listing | One-level directory listing of `<prefix>/<theme>/` through the storage API, `.mp4` files only | Background packs are flat directories; the storage API lists one level per request. The 5-minute list cache stays. |
| share-transcript renderer version | A sidecar object `<pdf key>.version` holding the version string, written after the PDF | The storage API has no custom metadata. The PDF key is predicted by the app and cannot carry the version. A missing or older marker is a cache miss, exactly as the metadata tag was. |
| share-transcript HTTP client | `httpx` (already installed through `litellm`), now declared directly; `boto3` removed | `httpx.MockTransport` makes the adapter testable without a network; no new package reaches the image. |
| `STORAGE_BACKEND` on share-* | Removed as a knob | There is one backend; a switch with one legal value is dead configuration. |
| MCP `targets` slice in use cases | Kept; wiring builds at most one target | The use cases are generic over N targets and tested that way; collapsing them is a refactor with no behaviour change. |
| Region fields in the MCP | Typed fields for everything the app reads (`shareTranscriptUrl`, `discoveryBaseUrl` added) plus a pass-through map for any other key; upsert merges, `clear` removes named optional fields | Round-trips a field the Go code has never heard of, and an upsert that names only the required fields cannot switch a feature off by accident. |
| social-poster `ru` region | Removed from the example; the ru-language campaign reads the `global` catalog | The mirror carries the same catalog, and the regional share-audio no longer exists; through the edge the old URL would still reach origin, so a deployed config keeps working until it is edited. |
| Public base of share-* in compose | `SHRUTI_MEDIA_BASE_URL`, no default | It already names the pull zone chat and corpus-mcp serve from. A placeholder default would satisfy the "refuses to start without a public base" check and hand clients dead URLs; with none, a host missing the value stops at boot. |
| Key shapes | Every caller value that becomes part of a storage key is matched whole against a closed shape (share-transcript `track_id`, `lang`, `transcript_key`; share-audio and share-video `source_key`), and the storage clients escape each key segment, refuse empty/`.`/`..` segments and check the URL stays under the zone | Validation at the boundary closes the traversal; the client-side check makes a later caller that forgets it fail closed. |
| Lost version-marker write | The process remembers the key and the next request for it rewrites only the marker | A flaky marker write costs one render, not one per request; after a restart the worst case is one more render. |
| PDF download filename and caching headers | Not set | The storage API keeps no per-object headers besides the content type; the app names the shared file itself and caching is the pull zone's configuration. |
| Tracing headers on an edge host | Excluded for `/public/*` | Storage reads now go to a service host; a `sentry-trace` header there would turn a simple CDN GET into a preflighted one. |
| Mobile regional seed | `urlTemplate: ${HOST_RU}/{path}` | The edge serves `/public/*` from the CDN on the same host as the services, so a first launch needs only one reachable host. |

---

## 3. Observable Acceptance Criteria (AC)

### Share services
- [x] **AC-1**: share-audio `config.Load` fails without `STORAGE_ZONE`, `STORAGE_KEY` or `EXCERPTS_PUBLIC_BASE`, and a config carrying only the old `BUCKET`/`S3_ENDPOINT_URL` does not start.
- [x] **AC-2**: share-audio builds excerpt and source URLs from the public base only; no code path composes an `amazonaws.com` URL.
- [x] **AC-3**: share-video `config.Load` fails without `STORAGE_ZONE`, `STORAGE_KEY` or `OUTPUT_PUBLIC_BASE`; `SHRUTI_S3_BUCKET` is no longer required.
- [x] **AC-4**: share-video downloads the source through the Bunny storage API (`GET {endpoint}/{zone}/{key}` with `AccessKey`).
- [x] **AC-5**: share-video lists `<prefix>/<theme>/` through the storage API (trailing slash, `AccessKey`), returns full keys of `.mp4` files and skips directories; an empty theme is `ErrUnknownTheme`.
- [x] **AC-6**: share-video uploads the reel through the storage API and returns `OUTPUT_PUBLIC_BASE/<key>`.
- [x] **AC-7**: share-transcript `config.load` fails without `STORAGE_ZONE`, `STORAGE_KEY` or `PDFS_PUBLIC_BASE`.
- [x] **AC-8**: share-transcript reads the transcript JSON, probes existence and writes the PDF through the storage API; a `404` is "absent", any other non-success status raises.
- [x] **AC-9**: a cached PDF counts as present only when its `.version` marker equals the current renderer version; the marker is written after the PDF.
- [x] **AC-10**: no share service references `S3_ENDPOINT_URL`, `SHRUTI_S3_PUBLIC_BASE`, `AWS_REGION` or an S3 SDK.
- [x] **AC-10b**: a `track_id`, `lang` or `transcript_key` outside its shape, or a `transcript_key` of another track, is refused with 400 before any storage call; a share-audio or share-video `source_key` with a `.`/`..`/empty segment or a character needing escaping is refused; the storage clients refuse such keys and keep `#`, `?`, `%` inside their segment.
- [x] **AC-10c**: when the marker write fails after the PDF was stored, a later request rewrites only the marker and answers ready, without a second render.

### shruti-mcp
- [x] **AC-11**: with a Bunny zone configured, the publish targets are exactly one uploader named `bunny`; without one, there are none. The config has no `aws`/`yandex` target.
- [x] **AC-12**: `regions.upsert` over an existing region keeps `shareTranscriptUrl`, `discoveryBaseUrl`, `profileBaseUrl`, `orchestratorBaseUrl` when the input leaves them out, and any unknown key; `clear` removes named optional fields and refuses other names and fields the input also supplies; `regions.remove` leaves every field of the remaining regions intact.
- [x] **AC-13**: `regions.upsert` accepts and validates (https) `shareTranscriptUrl` and `discoveryBaseUrl`.

### Proxy role
- [x] **AC-14**: no `proxy` role remains: no `role-proxy.conf`, no `docker-compose.proxy.yml`, no `proxy` profile, `deploy.sh --role proxy` is rejected.
- [x] **AC-15**: `caddy adapt` for origin is byte-identical before and after; the edge's differs only in its access-log format (AC-16b).
- [x] **AC-16**: `infra/tests/edge-e2e.sh` passes.
- [x] **AC-16b**: the edge's access log line holds only time, client address, method, path without query string, status and duration; no query value or request header value appears in any edge log line. Origin's logging is unchanged.
- [x] **AC-16c**: `deploy.sh --role edge` still accepts a host running the regional share stack (postgres, redis, migrator, share-*, watchtower, docker-socket-proxy) and refuses anything else without `--force-role-switch`.

### Mobile seed
- [x] **AC-17**: `SERVERS` has no `legacy` entry, every seed passes the registry's validation (`setRegions(SERVERS)` applies), and the regional seed's `urlTemplate` is on the same host as its `chatBaseUrl`.
- [x] **AC-17b**: tracing headers are not attached to `/public/*` on a service host, so a storage read through an edge sends the CDN no CORS preflight.

### Docs
- [x] **AC-18**: no doc under `docs/repos/shruti/` or `infra/app/README.md` describes AWS as the source of truth, an rclone mirror, the proxy role, region-header injection or auth/chat running on the regional host.

---

## 4. Technical Risks, Failure Modes & Edge Cases

| Risk / Failure Vector | Impact | Mitigation Strategy in Code |
| :--- | :---: | :--- |
| A share service starts on origin with no Bunny key | High | `Load` refuses to start (AC-1/3/7); compose passes the key from `.env`. |
| Merging before the edge is live | High | **Hard precondition: every regional host runs `edge` before this merges.** A host still on the removed role runs Watchtower, which pulls the new Caddy and share-* images; Caddy has no site for that role and the share services lack their new settings, so the host stops serving. |
| Origin redeployed by Watchtower alone | High | The new share-* images need `STORAGE_ZONE`, `STORAGE_KEY` and a public base the old containers were not given; Watchtower keeps the old container env. The operator sets `SHRUTI_STORAGE_KEY` and `SHRUTI_MEDIA_BASE_URL` in origin's `.env` and redeploys with `deploy.sh`. |
| Path traversal through caller-supplied keys | High | Key shapes at the boundary and in the storage clients (AC-10b). |
| Stale layout PDFs after a renderer bump | Medium | Version marker (AC-9). |
| Installed apps with a bundled seed | Medium | Installed apps use the persisted `config.json` regions; the seed only matters on a first launch before any fetch. |
| MCP config with the old `s3.aws` block | Low | Tool, runs locally; the unknown yaml key is ignored and publish uses Bunny only. |
| Region field dropped by the MCP | High | Pass-through map (AC-12). |

---

## 5. Blast Radius & Target Files

| File | Action | Purpose & Scope |
| :--- | :---: | :--- |
| `modules/services/share-audio/internal/storage/{s3.go,store.go,bunny.go}` | DELETE/MODIFY | Bunny only; `DownloadTo` removed. |
| `modules/services/share-audio/internal/{config,pipeline}`, `cmd/share-audio/main.go`, `go.mod`, `README.md` | MODIFY | Bunny-only config, wiring, AWS SDK dropped. |
| `modules/services/share-video/internal/storage/*` | MODIFY/DELETE | One Bunny client: download, list, put. |
| `modules/services/share-video/internal/pipeline/{render.go,backgrounds.go,io.go}` | MODIFY | Reads and writes through the store port. |
| `modules/services/share-video/internal/{config,httpx}`, `cmd/share-video/main.go`, `go.mod`, `README.md` | MODIFY | Bunny-only config; dead `Server` fields removed. |
| `modules/services/share-transcript/app/src/share_transcript/{config,bunny,ports,pipeline,main}.py`, `s3.py` | CREATE/MODIFY/DELETE | Bunny adapter behind a port. |
| `modules/services/share-transcript/app/{pyproject.toml,tests/}`, `.github/workflows/services-share-transcript-tests.yml` | MODIFY/CREATE | Dev extra, tests, CI. |
| `modules/tools/shruti-mcp/{cmd/shruti-mcp,internal/config,internal/infra/s3/aws}` | MODIFY/DELETE | Single Bunny target. |
| `modules/tools/shruti-mcp/internal/{application/catalog/regions,mcp/tools/regions.go}` | MODIFY | Field-preserving regions. |
| `modules/tools/shruti-mcp/shruti-mcp.example.yaml`, docs | MODIFY | Config shape. |
| `modules/libs/domain/servers.ts` | MODIFY | Seeds. |
| `modules/apps/mobile/shruti/services/__tests__/bundledSeeds.test.ts` | CREATE | Seed validity. |
| `modules/apps/mobile/shruti/services/monitoring/tracePropagationTargets.ts` (+ test) | MODIFY | No tracing headers on `/public/*`. |
| `infra/app/scripts/gen-dev-env.sh` | MODIFY | Dev env names the storage key. |
| `modules/services/social-poster/{config.example.yaml,README.md}`, `infra/app/compose/docker-compose.social-poster.yml` | MODIFY | Regional share-audio removed. |
| `infra/app/compose/{docker-compose.yml,docker-compose.prod.yml,docker-compose.edge.yml,docker-compose.dev.yml}` | MODIFY | Profiles, share-* env. |
| `infra/app/compose/docker-compose.proxy.yml`, `infra/app/compose/caddy/role-proxy.conf` | DELETE | Proxy role. |
| `infra/app/compose/caddy/{Caddyfile,Dockerfile,role-origin.conf}` | MODIFY | Proxy snippets out. |
| `infra/app/scripts/lib/edge-checks.sh` | MODIFY | Switch guard wording. |
| `modules/apps/web/src/legal/privacy.*.md` | MODIFY | The chat routing section is removed; the effective date is updated. |
| `modules/services/{chat,ingest}`, mobile `regionFailover.ts`, `useHttpShareAudioService.ts` | MODIFY | Comments describing the removed topology. |
| `infra/app/scripts/deploy.sh`, `infra/app/.env.example`, `infra/app/README.md`, `infra/tests/edge-e2e.sh` | MODIFY | Proxy role out. |
| `docs/repos/shruti/**` | MODIFY | Topology. |

Consumers checked: `SERVERS` (registry seed, dev region, trace-propagation test), the `legacy` id (only a generic fixture id in `regionFailover.test.ts`, unrelated), `SHRUTI_S3_PUBLIC_BASE`/`SHRUTI_S3_ENDPOINT_URL` (share-* and ingest/publish-service compose entries), `SHRUTI_REGION_ROLE` (Caddyfile, compose, deploy.sh), `SHRUTI_GLOBAL_HOST` (edge — kept).

---

## 6. Phased Execution Plan

### Phase 1: Red
- [x] share-audio / share-video / share-transcript config and adapter tests; shruti-mcp target and region tests; mobile seed test. Failing output captured.

### Phase 2: Green
- [x] Share services, MCP, seeds.

### Phase 3: Wiring
- [x] Compose, Caddy, deploy.sh, `.env.example`, CI workflow, docs.

### Phase 4: Gate
- [x] Hand mutation check of each new test; full gate below.

---

## 7. Verification Gate

```bash
for m in services/share-audio services/share-video services/social-poster tools/shruti-mcp; do
  (cd modules/$m && go build ./... && go vet ./... && go test ./... -count=1 -race && golangci-lint run ./...)
done
(cd modules/services/share-transcript/app && pip install -e ".[dev]" && python -m pytest tests -q && ruff check .)
(cd modules/apps/mobile && npx vitest run && npx vue-tsc --noEmit && npm run lint)
infra/tests/edge-e2e.sh
```

# Task Specification: Stateless `edge` role + cheap storage-sync full pass

**Branch / Worktree**: `feat/edge-role`
**Status**: `COMPLETED`
**Target Modules**: `infra/app/compose`, `infra/app/scripts`, `infra/tests`, `modules/services/storage-sync`

---

## 0. Prior art

- [Caddy `reverse_proxy` — transport `http`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#the-http-transport):
  `versions`, `keepalive`, `keepalive_idle_conns_per_host`, `header_up Host`, `flush_interval -1`; TLS upstreams negotiate HTTP/2 through ALPN and reuse the pool.
- [Caddy global options — `servers { protocols }` / `trusted_proxies`](https://caddyserver.com/docs/caddyfile/options#protocols):
  HTTP/3 is on by default and advertised with `Alt-Svc`; `protocols h1 h2` removes it. `X-Forwarded-For` is replaced, not appended, unless the peer is a trusted proxy.
- [Amazon S3 `ListObjectsV2`](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html):
  each page returns up to 1000 keys with `Size` and `ETag`, so one LIST request carries the size of a thousand objects that a HEAD-per-object pass pays for one at a time.
- [rclone `--size-only` / `--checksum`](https://rclone.org/docs/#size-only) and [`--fast-list`](https://rclone.org/docs/#fast-list):
  the established sync split — compare by listing (size, mod-time) on the regular run, pay for checksums only when asked; checksum-only runs are the expensive mode.
- [RFC 9110 §14 — Range requests](https://www.rfc-editor.org/rfc/rfc9110#name-range-requests):
  an intermediary that forwards `Range` and passes `206`/`Content-Range` through unchanged stays transparent to media players.
- [RFC 9113 §9.1 — HTTP/2 connection management](https://www.rfc-editor.org/rfc/rfc9113#name-connection-management):
  clients keep one long-lived connection per origin and multiplex; opening a connection per request is the anti-pattern.

**Adopted**: a Caddy-only edge that forwards everything over pooled, long-lived TLS connections (HTTP/2 where the upstream offers it), and a listing-driven sync that pays for checksums only on a named set of mutable keys and on a slow deep cadence.
**Rejected**: (a) an edge with its own allowlist of API paths — it duplicates origin's route table and drifts on every new route; (b) keeping a per-object HEAD in the hourly pass with a smaller worker pool — it lowers the request rate, not the request count.

---

## 1. Business Context & User Value (JTBD)

### Problem Statement & Trigger
- **Trigger**: users whose network reachability to origin is poor go through a regional box. Today that box is the `proxy` role, which runs postgres, redis, the migrator and three share services just to terminate `/share/*` locally.
- **Pain Point**: the regional box is stateful and heavy for what is mostly a forwarding job; and the storage mirror's hourly pass issues one HEAD per stored object on the mirror, which dominates the mirror's request volume.
- **Current Workaround**: run the full `proxy` stack; accept the HEAD volume.

### User Journey & Workflow (Before vs After)
- **Before**: a regional host needs a DB password, JWT keys, five data services; the mirror is HEAD-checked object by object every hour.
- **After**: a regional host needs only Caddy and two upstream URLs; the mirror is compared by one paginated LIST per pass, with checksums only where content can change under the same key.

### Value & Success Criteria
- **Primary Value Delivered**: a regional entry point with no state to back up, migrate or keep in sync; mirror requests per pass drop from O(objects) HEADs to O(objects/1000) LISTs + O(mutable keys) HEADs.
- **Observable Verification**: `/healthz`, `/healthz/api`, `/healthz/cdn` on the edge; the `sync_pass_done` log line carries `listed`, `heads`, `copied`, `bytes`, `deep`.

---

## 2. Goals, Non-Goals & Scope Guardrails

### In-Scope Goals
- Role `edge` in the Caddy image, compose overlay, `deploy.sh`, README and `.env.example`.
- An automated edge test against stub upstreams, wired into CI.
- storage-sync: listing-based regular pass, mutable-key checksum set, deep pass on its own cadence, exclude prefixes, pass counters.

### Non-Goals
- Removing the `proxy` role (it stays as the rollback path).
- Any change to origin's or proxy's routing, rate limits, headers or HTTP versions.
- DNS, certificates, CDN configuration, provisioning, deploying.
- A metrics endpoint for storage-sync (its observability is structured logs; counters go there).
- Changing the `track.ready` fast path.

### Decisions
| Question | Decision | Why |
| :--- | :--- | :--- |
| Catch-all or allowlist | **Catch-all** to origin, `/public/*` to the CDN | Origin's route table is the single source of truth for what exists; origin is itself public, so a catch-all exposes nothing new, and an allowlist would 404 every route added to origin until the edge is re-released. |
| `/webhooks/*` | **Forwarded by the catch-all, not special-cased** | Providers are configured against origin and keep calling it directly. Their authentication (bearer secret, HMAC over the body) is end to end and the edge does not touch body or `Authorization`, so a webhook that does arrive through the edge still verifies. Blocking it gains nothing: the same path is public on origin. |
| Watchtower on the edge | **Not run**; `docker-socket-proxy` not run | Caddy is the only container. Leaving it without Watchtower removes the docker-socket exposure from the host and makes an edge image roll a deliberate `deploy.sh` run: an edge that fails to start is a regional outage, and nothing else on the host needs rolling. |
| Rate limiting | **None on the edge** | Origin keys every zone on `{client_ip}` and trusts the configured edge CIDRs, so it already limits per real client. The edge replaces any client-sent `X-Forwarded-For` (it trusts no proxy), so the address origin sees cannot be forged past it. Counting again on the edge would add a second, per-node bucket with the same key and nothing to protect. **Ops precondition**: the edge's egress address must be in origin's `SHRUTI_TRUSTED_EDGE_CIDRS`, otherwise origin collapses every edge user into one bucket. |
| HTTP/3 | Off on the edge (`protocols h1 h2`, no UDP port) | An `Alt-Svc: h3` from the edge would point clients at a UDP port it does not serve. The upstreams' own `Alt-Svc` is dropped by `reverse_proxy` itself. |
| Mutable-key default | `public/config.json,public/db/pending.db` | The catalog manifest and the pending DB are rewritten in place on every publish, so they are read by checksum every pass. They are not the only in-place rewrites: `audiodenoise` rewrites `public/tracks/<id>/audio/clean.mp3` (CBR, so often the same size), and transcripts, author avatars and covers are rewritten under fixed keys without a `track.ready`. Those are not added to the list (that would bring back one HEAD per track); they are caught by the held-checksum record below. |
| Same-size rewrites | Held-checksum record, no extra requests | The source listing carries each object's checksum. The core keeps, per key, the checksum the mirror was last seen holding — filled by every checksum read (the deep pass reads them all) and every copy (full pass and fast path). A regular pass ships an object whose source checksum differs from that record. Keys without a record (after a restart, or legacy unstamped objects) fall back to size until the next deep pass; the first pass after start is deep. |
| Persistent per-object failure | Deep pass counts as done anyway; failed keys retried | A deep pass is recorded once the walk and listing succeed. Keys whose read or copy failed are read again on the next pass (`retrying` in the pass log), so one stuck object costs one HEAD per pass, not a deep pass per pass. |
| Event path and excludes | Excluded keys are skipped on the fast path too | Otherwise an excluded key announced by `track.ready` would be copied and then never pruned. |
| Client headers | CDN: `Authorization`, `Cookie`, `X-Real-IP` dropped. Origin: `X-Real-IP`, `Forwarded`, `True-Client-IP`, `CF-Connecting-IP`, `X-Client-IP`, `Client-IP`, `X-Cluster-Client-IP`, `Fastly-Client-IP`, `X-Original-Forwarded-For` dropped | Public objects need no credentials, and user tokens must not reach the CDN provider. No origin service reads those address headers (they read `X-Forwarded-For`), so dropping them costs nothing and keeps a client from posing as another address if one ever does. |
| Wrong-host guard | `deploy.sh --role edge` refuses a host running any service outside a proxy's set (caddy, watchtower, docker-socket-proxy, postgres, redis, migrator, share-*) unless `--force-role-switch` | Keyed on what the host runs, not on its `.env` role, because the `.env` is exactly what an operator edits when switching. An allowlist of the proxy's services instead of a list of origin services: a service added to origin later is blocked by default. A proxy host becomes an edge without the flag. |
| First pass after start | Deep | Restarts are rare; this bounds the gap between deep verifications even for a process that restarts more often than the deep interval, and makes one-shot mode a single deep pass. |

---

## 3. Observable Acceptance Criteria (AC)

### Edge (infra)
- [x] **AC-1**: `caddy validate` passes for `origin`, `proxy` and `edge` (Dockerfile build and the test script).
- [x] **AC-2**: `caddy adapt` output for `origin` and `proxy` is identical with and without this change, except for an explicit `protocols` list, which equals Caddy's default (`h1 h2 h3`), and for `/healthz` and `/readyz` in the chat zone's exclusions (AC-26).
- [x] **AC-3**: on the edge, `GET /public/<obj>` reaches the CDN upstream with `Host` and SNI equal to the CDN host.
- [x] **AC-4**: a `POST` with a body and `Authorization` reaches the origin upstream intact, with `Host`/SNI = origin host and `X-Forwarded-For`/`X-Forwarded-Host` set.
- [x] **AC-5**: an SSE response through the edge delivers its first event before the upstream finishes the stream, and a `/public/*` body with a known length is delivered as it arrives, not after an upstream stall ends.
- [x] **AC-6**: `Range: bytes=a-b` on `/public/*` returns `206` with exactly the requested bytes.
- [x] **AC-7**: `/share/audio/...` on the edge goes to origin, not to a local share service.
- [x] **AC-8**: `/healthz` is answered by the edge with a body naming the role; `/healthz/api` returns origin's `/healthz`; `/healthz/cdn` returns the configured probe object (> 64 KB) in full.
- [x] **AC-9**: no response from the edge carries an `Alt-Svc` advertising `h3`, including when the upstream sends one.
- [x] **AC-10**: `COMPOSE_PROFILES=edge` over `docker-compose.prod.yml` + `docker-compose.edge.yml` resolves to exactly one service, `caddy`, without `SHRUTI_POSTGRES_PASSWORD` set, publishing no UDP port.
- [x] **AC-11**: `deploy.sh --role edge` is accepted, skips JWT/DB checks, and health-checks `/healthz`, `/healthz/api`, `/healthz/cdn`.
- [x] **AC-21**: the deploy's `/healthz/cdn` check (`infra/app/scripts/lib/edge-checks.sh`) fails when the CDN stalls part-way through the probe object, and passes when it arrives whole, larger than 64 KB and matching `Content-Length`.
- [x] **AC-22**: `deploy.sh --role edge` refuses a Docker Compose older than 2.24.4.
- [x] **AC-23**: after an edge deploy no container of the project runs a service the edge set does not run, including profile-disabled ones (Watchtower, docker-socket-proxy); the cleanup refuses to run without `COMPOSE_PROFILES`; an edge deploy to a host running services outside a proxy's set is refused without `--force-role-switch`.
- [x] **AC-24**: the CDN never receives the client's `Authorization`, `Cookie` or `X-Real-IP`; origin never receives a client-sent `X-Real-IP`, `Forwarded`, `True-Client-IP`, `CF-Connecting-IP`, `X-Client-IP`, `Client-IP`, `X-Cluster-Client-IP`, `Fastly-Client-IP` or `X-Original-Forwarded-For`.
- [x] **AC-26**: on origin (and proxy), `/healthz` and `/readyz` fall in no rate-limit zone: over 1000 probes of each from one client are never answered 429 and leave the client's chat budget untouched.

### storage-sync
- [x] **AC-12**: a regular pass skips an object present in the mirror listing with the same size, without a HEAD.
- [x] **AC-13**: a regular pass copies an object whose listed size differs, or that is absent from the listing.
- [x] **AC-14**: a mutable key with the same size is HEAD-compared by checksum every pass and copied when the checksum differs.
- [x] **AC-15**: the number of HEADs in a regular pass is at most the number of mutable keys plus keys whose previous attempt failed.
- [x] **AC-16**: a deep pass (checksum on every listed object) runs on the first pass and then once per `SYNC_DEEP_INTERVAL`; it counts as done even when some objects fail, and those objects are retried on the following passes; `SYNC_DEEP_INTERVAL=0` makes every pass deep.
- [x] **AC-17**: keys under `SYNC_EXCLUDE_PREFIXES` are neither copied (by the full pass or the event path) nor pruned, even with `SYNC_DELETE=true`; the default is empty; an exclude prefix or mutable pattern with a leading slash fails config load.
- [x] **AC-18**: `sync_pass_done` / `sync_pass_failed` log `listed`, `heads`, `copied`, `bytes`, `deep`, `retrying`.
- [x] **AC-19**: `SyncKeys` / `SyncTrack` decide by the mirror's checksum stamp (`mirror.NeedsTransfer`), skip excluded keys, and record what they copy or read in the held-checksum record.
- [x] **AC-20**: an object rewritten in place with the same size is shipped on the next regular pass with no HEAD, once its mirror checksum is known (deep pass, earlier copy, or fast-path copy).
- [x] **AC-25**: the checksum record holds no key that the latest full-pass source listing does not have.

---

## 4. Technical Risks, Failure Modes & Edge Cases

| Risk / Failure Vector | Impact | Mitigation Strategy in Code |
| :--- | :---: | :--- |
| Origin not trusting the edge address | High | Documented as an ops precondition in README and PR; this change does not alter origin's configuration. |
| Refactor of the shared Caddyfile changes origin/proxy | High | `caddy adapt` diff before/after for both roles (AC-2). |
| Same-size content change on a non-mutable key | Medium | Held-checksum record catches it on the next regular pass; without a record (restart, legacy object) the deep pass within `SYNC_DEEP_INTERVAL` does (AC-20). |
| Listing taken before a fast-path copy lands | Low | The pass re-copies an object it saw missing; the write is idempotent. |
| Prune deleting an excluded prefix | High | Exclusion is applied to the mirror listing before the prune diff (AC-17). |
| Edge upstream stalls after the first bytes | Medium | `/healthz/cdn` streams a > 64 KB object, so a probe with a timeout sees the stall. |
| Bad mutable-key pattern | Low | Patterns are validated at config load; the service refuses to start. |

---

## 5. Blast Radius & Target Files

| File | Action | Purpose & Scope |
| :--- | :---: | :--- |
| `infra/app/compose/caddy/Caddyfile` | MODIFY | Shared API site body moved into a snippet; site picks `site-<role>`; `protocols` from env. |
| `infra/app/compose/caddy/role-edge.conf` | CREATE | Edge routes. |
| `infra/app/compose/caddy/Dockerfile` | MODIFY | Ship and validate `role-edge.conf`. |
| `infra/app/compose/docker-compose.edge.yml` | CREATE | Caddy-only overlay. |
| `infra/app/scripts/deploy.sh` | MODIFY | `--role edge`. |
| `infra/app/scripts/lib/edge-checks.sh` | CREATE | CDN probe check and Compose version gate, shared by `deploy.sh` and the edge test. |
| `infra/app/scripts/remove-inactive-services.sh` | CREATE | Removes containers of services the active role defines but does not run. |
| `infra/app/README.md`, `infra/app/.env.example` | MODIFY | Role table, edge section, variables. |
| `infra/tests/edge-e2e.sh`, `infra/tests/stub-upstream/*` | CREATE | Edge test and stub upstream. |
| `.github/workflows/infra-app-edge.yml` | CREATE | Runs the edge test. |
| `modules/services/storage-sync/internal/domain/mirror/*` | MODIFY | `Listed`, `Scope`, `Compare`. |
| `modules/services/storage-sync/internal/ports/ports.go` | MODIFY | `MirrorStore.List` replaces `ListKeys`. |
| `modules/services/storage-sync/internal/application/runmirror/*` | MODIFY | Regular/deep pass, counters. |
| `modules/services/storage-sync/internal/infra/yandex/yandex.go` | MODIFY | `List` with sizes. |
| `modules/services/storage-sync/internal/config/*` | MODIFY/CREATE | New env + tests. |
| `modules/services/storage-sync/internal/wire/wire.go`, `cmd/storage-sync/main.go` | MODIFY | Wiring and log fields. |
| `infra/app/compose/docker-compose.yml` | MODIFY | Pass the new storage-sync env with production-preserving defaults. |

---

## 6. Phased Execution Plan

### Phase 1: Red
- [x] storage-sync port change + fakes (contract), then acceptance tests; `go test ./...` fails.
- [x] `infra/tests/edge-e2e.sh` written; fails against the unmodified Caddy image (no `role-edge`).

### Phase 2: Green
- [x] storage-sync domain, core, adapter, config, wiring.
- [x] Caddyfile restructure, `role-edge.conf`, Dockerfile, compose overlay.

### Phase 3: Wiring
- [x] `deploy.sh --role edge`; README; `.env.example`; CI workflow.

### Phase 4: Gate
- [x] Hand mutation check of each new test.
- [x] Full gate below.

---

## 7. Verification Gate

```bash
cd modules/services/storage-sync && go build ./... && go vet ./... && go test ./... -count=1 -race && golangci-lint run ./...
infra/tests/edge-e2e.sh
```

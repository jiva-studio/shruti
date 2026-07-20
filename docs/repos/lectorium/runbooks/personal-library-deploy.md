# Personal library — deployment runbook

Rolling out the personal-library feature is **not** an ordinary Watchtower auto-deploy, because it introduces **three new services** (`orchestrator`, the stateless `ingest` worker, and `publish-service`) and **new infra** (a dedicated `redis-streams` broker + `orchestrator-postgres` + `publish-postgres`) — **six new containers** in total. Watchtower only rolls *existing* containers to a newer image; it cannot create containers that a changed `docker-compose.yml` adds. New containers require a **structural deploy via `deploy.sh`**. This runbook is the exact order. See [Personal library](../architecture/personal-library.md).

> **Prereq:** the stacked PRs are merged to `main`, so CI has built the images. The stack is linear — its tip contains every earlier branch's content (several files *moved* between services in the last two PRs, so a branch whose head is not an ancestor of the tip may still be fully included). Nothing here works before the merge: the image build runs only on push to `main`.

## What ships how

| Change | Mechanism |
|---|---|
| `chat`, `profile` image updates (existing services) | CI builds → **Watchtower** auto-rolls |
| chat schema (`0043_chat_user_tracks`, `0044_chat_owned`) | **central `migrator`** (one-shot) — driven by `deploy.sh` |
| **new** `orchestrator` + `ingest` + `publish-service` + `orchestrator-postgres` + `publish-postgres` + `redis-streams` | **structural — `deploy.sh`** (Watchtower can't create them) |
| `orchestrator` schema (`jobs`, `outbox`) | self-migrates on boot (own DB, advisory-locked) |
| `publish-service` schema (`publish.tracks`, outbox) | self-migrates on boot (own DB, advisory-locked) |
| `profile` schema (`library_items`) | self-migrates on boot (own DB) |
| `storage-sync` gains a `track.events` consumer + a health port | image update — **Watchtower**, but it needs the new env (see step 2) |
| observability: second postgres-exporter, alert group, blackbox targets | **structural** on the obs-agent + obs hosts (separate compose projects) |

Because the change is **schema-coupled** (chat's tables must exist before the new chat image serves), drive the release with `deploy.sh` (which orders the migrator), **not** Watchtower alone.

## Order of operations

1. **Merge → CI green.** Confirm GHCR has `ghcr.io/jiva-studio/lectorium-orchestrator:latest` and rebuilt `-chat`, `-profile`, `-migrator`.

2. **Set host secrets** in `/opt/lectorium/.env` (origin host) — real values, never committed:
   - `LECTORIUM_DEEPGRAM_API_KEY` — **the one that silently breaks everything if missed.** Without it every ingest burns its full attempt budget and dead-letters; the symptom is a spinner that never resolves. Validate before deploying: a `GET https://api.deepgram.com/v1/projects` with `Authorization: Token <key>` must return `200`.
   - `LECTORIUM_STORAGE_BACKEND=bunny` + `LECTORIUM_STORAGE_ZONE` + `LECTORIUM_STORAGE_KEY` — the ingest worker writes artifacts to Bunny, not S3.
   - `LECTORIUM_ORCHESTRATOR_POSTGRES_PASSWORD` and `LECTORIUM_PUBLISH_POSTGRES_PASSWORD` — **deploy-stoppers.** Both are declared `:?` in compose, so if either is missing `docker compose` fails while *parsing* and the deploy never starts. Do not invent a `DATABASE_URL` variable: compose derives each service's URL from these passwords. Note these are **not** generated for you on a server — `gen-dev-env.sh` generates them for local dev only.
   - `ORCHESTRATOR_PG_EXPORTER_PASSWORD` — the read-only role the orchestrator postgres-exporter connects as; also `:?`. `postgres/orchestrator-init.sh` reads it from the container environment, so there is **nothing to substitute by hand** — an earlier version of this file was a `.sql` template whose placeholder nothing ever replaced (and `deploy.sh` rsyncs that directory with `--delete`, so a host-side edit would be reverted on the next deploy). If this password is wrong the exporter cannot authenticate and every ingest alert reads no data while looking perfectly healthy.
   - `PENDING_S3_BUCKET` / `PENDING_S3_KEY` (default `public/db/pending.db`) / `PENDING_S3_ENDPOINT` + creds — for the profile → pending.db producer
   - image tags if pinning (`LECTORIUM_ORCHESTRATOR_TAG`, `LECTORIUM_INGEST_TAG`, …)
   - (`STREAMS_REDIS_URL` is internal — `redis://redis-streams:6379/0` — no secret)

   **`LECTORIUM_YTDLP_PROXY` is deliberately left empty.** It was assumed a residential proxy would be required, but a direct download from the origin host was measured against YouTube and works: no bot-check, native audio format, output identical to a residential run. Do not procure one on spec. The `--proxy` plumbing stays in the fetch adapter as the escape hatch if YouTube ever starts rate-limiting the host by volume — that failure surfaces as the download error text in the job's `error` column.

3. **Structural deploy.** Run `deploy.sh` for the **origin** role. It rsyncs `infra/`, runs `docker compose --profile origin pull && up -d --remove-orphans`, which **creates** all six new containers (`orchestrator`, `orchestrator-postgres`, `ingest`, `publish-service`, `publish-postgres`, `redis-streams`) and re-runs the one-shot `migrator` (applies chat 0043/0044). `orchestrator` / `publish-service` / `profile` self-migrate on boot; `/readyz` gates each until its schema is current.

   Deploying before the secrets in step 2 exist is safe but pointless: compose aborts at parse time, so nothing is created and the *running* stack is untouched.

4. **Push the Langfuse router prompt.** The `add-to-library` intent lives in a hosted Langfuse prompt that overrides the bundled `.md` at runtime. Until synced, chat's router never emits the intent and the feature is inert. Use `langfuse-prompts-sync` to push the router / response-shape sections.

5. **Deploy the observability side** (separate compose projects, so `deploy.sh` for the app stack does not touch them):
   - obs-agent host: brings up `orchestrator-postgres-exporter` on `:9188` with `orchestrator-queries.yaml`.
   - obs host: the new `orchestrator-postgres-*` scrape job, the three added blackbox targets, and the `library-ingest` alert group.
   - On an **existing** `orchestrator-postgres` volume the init script does not re-run (initdb scripts fire only on a fresh data directory), so apply it by hand once — it is idempotent and doubles as the password-rotation path:

     ```
     docker compose exec -e ORCHESTRATOR_PG_EXPORTER_PASSWORD=<pw> \
       orchestrator-postgres /docker-entrypoint-initdb.d/10-exporter.sh
     ```

6. **Verify.**
   - `service-probe orchestrator` / `ingest` / `publish-service` / `chat` / `profile` — healthy + expected build SHA.
   - `publish-service` fetched the corpus catalog: it reads `current.db` on a 5-minute tick to learn which track ids are already live. It **never writes it back** — the only blob it uploads is `pending.db`. A failing catalog fetch shows up as a promotion that never happens, not as a corrupted catalog.
   - `orchestrator` `/healthz` + `/readyz` (schema applied), and it can `XREADGROUP` an empty `ingest.request`.
   - `storage-sync` `/readyz` returns `200 ready` (not `503 stale`) once a full pass has completed.
   - Exporter is actually reading: `lectorium_orchestrator_oldest_unfinished_job_seconds` must be **present** in Prometheus. An absent series means the role/grants are wrong — and every ingest alert is silently blind.
   - A real end-to-end ingest: a PRO user pastes a lecture URL → item appears "processing" → flips to "ready" in My Library → chat can answer about it.
   - Follow that ingest in the logs on **one** id: `request_id` is the chat turn's trace_id and is carried through chat → orchestrator → ingest → storage-sync. The expected sequence is `job_created` → `ingest_started` → `ingest_fetched` → `ingest_transcribed` → `ingest_stored` → `ingest_ready` → `job_done` → `track_mirrored`. A gap tells you which stage broke without opening a database.
   - Confirm `pending.db` appears on S3 (producer ran) once there is at least one ready user track.

## Rollback

- Pin the previous image tag in `/opt/lectorium/.env` (e.g. `LECTORIUM_ORCHESTRATOR_TAG=main-<sha>`) and re-run `deploy.sh`.
- Migrations are additive/nullable, so a service rollback does not hit a schema it can't read.
- Redis-streams state survives (AOF); drain/replay via consumer-group offsets.
- To fully retract: scale `orchestrator` to 0 and stop publishing `ingest.request` (chat) — the rest stays dormant (the new tables are inert without traffic).

## When it breaks

The characteristic failure of this pipeline is **silent**: the orchestrator keeps accepting requests and writing job rows while the worker is gone or a dependency is down. Containers stay green, `/healthz` returns `200`, and the only symptom is users watching a spinner. That is what the `library-ingest` alert group exists for — start from the alert, not from the container list.

| Symptom | First look |
|---|---|
| `ingest_jobs_stalled` | `ingest` logs — silence means it is not receiving work (check `ingest_outbox_backlog`); `ingest_failed` at `level=error` names the failing stage |
| `ingest_outbox_backlog` | the relay is one goroutine in `orchestrator`; `outbox_drain_failed` in its logs. Restarting is safe — the outbox is transactional and event ids are derived from the job id, so redelivery is idempotent |
| `ingest_dead_letter_spike` | `job_dead_lettered` carries `exhausted`: `true` = our dependency is sick, `false` = the user's link was never ingestable |
| `storage_sync_mirror_stale` | `/readyz` body carries `last_error`. Usually a rotated Bunny key or expired Yandex creds — needs an `.env` fix, **not** a restart |

Failure text is durable in `orchestrator.jobs.error`, prefixed with the pipeline stage (`fetch:`, `transcribe:`, `put audio:`). The client never sees it: `track.failed` ships a stable `error_code` instead, so internals and vendor names stay off the user's device.

## Notes

- `lectorium-mcp` (the admin promotion tools, #1248) is **not** part of this deploy — it is the curator's local offline daemon, updated separately.
- The ingest image installs `yt-dlp` from PyPI at a **pinned** version, not `apk add yt-dlp` — the Alpine package trails the distro release by many months, and a stale yt-dlp degrades silently (it still produces a file, via a fallback path, until the release where it does not). Bump `YTDLP_VERSION` on a cadence; a stale pin is the most likely cause of a future "YouTube stopped working".
- The `pending.db` producer runs inside `profile` on an interval; it no-ops (logs a warning) when `PENDING_S3_BUCKET` is unset, so profile still boots without it configured.
- Keep proxy/host/topology specifics out of committed docs — they live only in `/opt/lectorium/.env`.

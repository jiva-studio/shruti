# Personal library — deployment runbook

Rolling out the personal-library feature is **not** an ordinary Watchtower auto-deploy, because it introduces a **new service** (`orchestrator`) and **new infra** (a dedicated `redis-streams` broker + `orchestrator-postgres`). Watchtower only rolls *existing* containers to a newer image; it cannot create containers that a changed `docker-compose.yml` adds. New containers require a **structural deploy via `deploy.sh`**. This runbook is the exact order. See [Personal library](../architecture/personal-library.md).

> **Prereq:** the 13 PRs are merged to `main` (wave-1 to `main`, then the integration branch to `main`), so CI has built the images. Nothing here works before that.

## What ships how

| Change | Mechanism |
|---|---|
| `chat`, `profile` image updates (existing services) | CI builds → **Watchtower** auto-rolls |
| chat schema (`0043_chat_user_tracks`, `0044_chat_owned`) | **central `migrator`** (one-shot) — driven by `deploy.sh` |
| **new** `orchestrator` service + `orchestrator-postgres` + `redis-streams` | **structural — `deploy.sh`** (Watchtower can't create them) |
| `orchestrator` schema (`jobs`, `outbox`) | self-migrates on boot (own DB, advisory-locked) |
| `profile` schema (`library_items`) | self-migrates on boot (own DB) |

Because the change is **schema-coupled** (chat's tables must exist before the new chat image serves), drive the release with `deploy.sh` (which orders the migrator), **not** Watchtower alone.

## Order of operations

1. **Merge → CI green.** Confirm GHCR has `ghcr.io/jiva-studio/lectorium-orchestrator:latest` and rebuilt `-chat`, `-profile`, `-migrator`.

2. **Set host secrets** in `/opt/lectorium/.env` (origin host) — real values, never committed:
   - `DEEPGRAM_API_KEY`
   - `YTDLP_PROXY` (the residential proxy URL)
   - `ORCHESTRATOR_POSTGRES_PASSWORD` + the derived `ORCHESTRATOR_DATABASE_URL`
   - `PENDING_S3_BUCKET` / `PENDING_S3_KEY` (default `public/db/pending.db`) / `PENDING_S3_ENDPOINT` + creds — for the profile → pending.db producer
   - image tags if pinning (`LECTORIUM_ORCHESTRATOR_TAG`, …)
   - (`STREAMS_REDIS_URL` is internal — `redis://redis-streams:6379/0` — no secret)

3. **Structural deploy.** Run `deploy.sh` for the **origin** role. It rsyncs `infra/`, runs `docker compose --profile origin pull && up -d --remove-orphans`, which **creates** `orchestrator`, `orchestrator-postgres`, `redis-streams`, and re-runs the one-shot `migrator` (applies chat 0043/0044). `orchestrator`/`profile` self-migrate on boot; `/readyz` gates each until its schema is current.

4. **Push the Langfuse router prompt.** The `add-to-library` intent lives in a hosted Langfuse prompt that overrides the bundled `.md` at runtime. Until synced, chat's router never emits the intent and the feature is inert. Use `langfuse-prompts-sync` to push the router / response-shape sections.

5. **Verify.**
   - `service-probe orchestrator` / `chat` / `profile` — healthy + expected build SHA.
   - `orchestrator` `/healthz` + `/readyz` (schema applied), and it can `XREADGROUP` an empty `ingest.request`.
   - A real end-to-end ingest: a PRO user pastes a lecture URL → item appears "processing" → flips to "ready" in My Library → chat can answer about it.
   - Confirm `pending.db` appears on S3 (producer ran) once there is at least one ready user track.

## Rollback

- Pin the previous image tag in `/opt/lectorium/.env` (e.g. `LECTORIUM_ORCHESTRATOR_TAG=main-<sha>`) and re-run `deploy.sh`.
- Migrations are additive/nullable, so a service rollback does not hit a schema it can't read.
- Redis-streams state survives (AOF); drain/replay via consumer-group offsets.
- To fully retract: scale `orchestrator` to 0 and stop publishing `ingest.request` (chat) — the rest stays dormant (the new tables are inert without traffic).

## Notes

- `lectorium-mcp` (the admin promotion tools, #1248) is **not** part of this deploy — it is the curator's local offline daemon, updated separately.
- The `pending.db` producer runs inside `profile` on an interval; it no-ops (logs a warning) when `PENDING_S3_BUCKET` is unset, so profile still boots without it configured.
- Keep proxy/host/topology specifics out of committed docs — they live only in `/opt/lectorium/.env`.

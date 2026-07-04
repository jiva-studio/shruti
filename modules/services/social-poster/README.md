# social-poster

One Go service that, on a schedule, picks content from the published
Lectorium catalog and posts it to social platforms. Two content kinds —
**daily wisdom** (short audio + text clip) and **lectures** (filtered by
dynamic rules like *on this day*) — selected via configurable **campaigns**
with pluggable **dynamic filters** (day, language, topic/trending, random).

v1 posts **audio + text** (Telegram) and **poster image + text** (VK,
Facebook). No video. Audio cutting is delegated to the existing
`share-audio` service.

## How it works

```
scheduler (cron)
  └─ per campaign: selector → content builder → publishers → state
catalog    pulls current.db from the CDN (same as the mobile app), read-only
selector   applies filters: on_this_day | language | topic/trending | random
           | not_posted_days
content    formats the caption; calls share-audio for the mp3 excerpt
publishers Telegram (sendAudio), VK (wall.post + photo), Facebook (Graph)
state      own SQLite: post log (anti-repeat, idempotency) + VK audio map
```

- **Data**: `daily_wisdom`, `tracks` (`date` → on-this-day), `track_variants`
  (title/audio_path), `topics`/`track_topics` (trending weight), resolved from
  the catalog SQLite fetched per region.
- **Audio**: Telegram `sendAudio` ingests the share-audio URL directly.
- **VK/Facebook**: poster image (from Bunny, `prebuilt`/`brand_static`) + text.
  VK can additionally attach a pre-uploaded audio by id (`attach_audio`, see
  the design doc for the one-time mapping).

## Config

Structure in `config.yaml` (see `config.example.yaml`); secrets via env vars
named by the `*_env` fields. Path via `CONFIG_PATH` (default
`/etc/social-poster/config.yaml`).

Required env (per configured target): `TELEGRAM_BOT_TOKEN`,
`VK_COMMUNITY_TOKEN`, `FB_PAGE_TOKEN` (names are whatever the YAML points at).

## HTTP (ops only)

- `GET /healthz` — status, build stamp, per-region catalog version.
- `GET /campaigns` — configured campaigns.
- `POST /run/{name}` — run a campaign now (synchronous), returns the report.
  Respects idempotency, so a manual run won't double-post.

## Env

| Var | Default | Notes |
| --- | --- | --- |
| `CONFIG_PATH` | `/etc/social-poster/config.yaml` | YAML config |
| `LOG_LEVEL` (in yaml) | `info` | |
| `LECTORIUM_BUILD_SHA` / `_TIME` | `dev` | surfaced on `/healthz` |

Plus the credential env vars referenced by the config's targets.

## Local dev

```bash
CONFIG_PATH=./config.yaml \
TELEGRAM_BOT_TOKEN=... VK_COMMUNITY_TOKEN=... FB_PAGE_TOKEN=... \
go run ./cmd/social-poster
```

## Deploy (prod)

The image is built + pushed by CI (`.github/workflows/services-ghcr.yml`,
service `social-poster`) to `ghcr.io/jiva-studio/lectorium-social-poster`.
Deploy is a non-invasive overlay on top of the base stack — it runs as a
single service on the **origin** host and reaches each region's share-audio
by the URL in its config.

1. Provision on the host:
   - `/opt/lectorium/social-poster/config.yaml` (from `config.example.yaml`,
     real channel/group/page ids + Bunny poster URLs).
   - In `.env`: `LECTORIUM_TELEGRAM_BOT_TOKEN`, `LECTORIUM_VK_COMMUNITY_TOKEN`,
     `LECTORIUM_FB_PAGE_TOKEN` (the overlay maps these to the plain names the
     config's `*_env` fields point at).
2. Bring it up:
   ```bash
   docker compose -f infra/app/compose/docker-compose.yml \
                  -f infra/app/compose/docker-compose.prod.yml \
                  -f infra/app/compose/docker-compose.social-poster.yml \
                  up -d social-poster
   ```
3. Verify: `docker logs` shows `scheduled_campaign` lines; `GET /healthz`
   returns per-region catalog versions. Trigger a one-off with
   `POST /run/{name}` before trusting the cron.

For VK audio (`attach_audio: true`), first run the bulk upload + reconcile —
see `resources/daily-wisdom/VK-AUDIO-SETUP.md`.

# lectorium-mcp

A Go MCP server that turns a local mp3 lake into a directory tree that mirrors
the public Lectorium S3 bucket (`akds-lectorium`) byte-for-byte. Pipeline:

```
ingest → track.audio.normalize → track.metadata.extract → track.transcript.create → track.transcript.review → track.commit
                                                                                          ↓
                                                              writes into out/artifacts/catalog/current.db
                                                                                          ↓
                                                                       catalog.publish → s3://akds-lectorium/
```

All MCP tools are stateless wrappers around use cases under `internal/application/`.
Naming convention: `<noun>_<verb>` (`track.audio.normalize`, `track.transcript.review`,
`catalog.publish`, `author.resolve` etc.).

## Layout

```
cmd/lectorium-mcp/main.go      composition root
internal/
  domain/                       pure: track, transcript, pipeline, catalog
  ports/                        interfaces only
  application/                  use cases (one per stage)
  infra/                        adapters: sqlite (lake + catalog), ffmpeg,
                                transcriber-service, anthropic, http cdn, aws s3
  mcp/                          MCP driving adapter (tools)
```

Output tree under `--out` mirrors S3:

```
out/
├── public/                     ← required by mobile app
│   ├── config.json             ← merged on publish
│   ├── db/lectorium.{ver}.db
│   └── tracks/{id}/audio/original.mp3
│   └── tracks/{id}/transcripts/{lang}.json
└── artifacts/                  ← internal-only; uploaded under s3://.../artifacts/
    ├── catalog/{current,snapshot.{ver}}.db + meta.json
    ├── lake/index.db           ← path → trackId + per-stage state
    └── tracks/{id}/...         ← source.mp3, raw.json, review.json, meta.json
```

`aws s3 sync out/ s3://akds-lectorium/` syncs everything in one shot.

## Building & running (daemon mode)

`lectorium-mcp` is a long-running HTTP/SSE MCP daemon. One process, one
port (default `127.0.0.1:8081`). Two endpoints:

- `/mcp` — streamable HTTP (preferred)
- `/sse` — SSE (deprecated but still available for older clients)

Lifecycle is driven by the in-package Makefile (mirrors `transcriber-mcp`):

```sh
make build           # compile to ./bin/lectorium-mcp
make up              # start in background, pid in /tmp/lectorium-mcp.pid
make status          # is it alive?
make logs            # tail -F /tmp/lectorium-mcp.log
make restart         # down + up
make down            # SIGTERM → wait → SIGKILL fallback
```

`make up` cd's into `RUN_DIR` (default = this module's root, where the
Makefile lives) before exec so the binary picks up `./lectorium-mcp.yaml`
+ `./.env` sitting next to it. Override with e.g. `make up RUN_DIR=/some/project`.

CLI flags:

```sh
./bin/lectorium-mcp \
  -addr 127.0.0.1:8081 \         # listen address
  -workers 4 \                   # worker pool size (file-level)
  -transcribe-concurrency 2 \    # max concurrent transcribe calls (M-box cap)
  -heartbeat-interval 15s        # MCP keepalive
```

For dry config inspection without starting the server:

```sh
./bin/lectorium-mcp --config ./lectorium-mcp.yaml --serve=false
```

The first start auto-runs `catalog.refresh` to download the latest catalog
DB into `out/artifacts/catalog/current.db`.

## Connecting Claude Code

`.mcp.json` (project-local) connects via URL, not by spawning a subprocess:

```json
{
  "mcpServers": {
    "lectorium": {
      "type": "http",
      "url": "http://127.0.0.1:8081/mcp"
    }
  }
}
```

Start the daemon (`make up`) before opening the project in Claude Code.
The daemon survives CC sessions — pool state, jobs in flight, registry
state all persist across reloads.

## Configuration

YAML config supports `${ENV_VAR}` substitution and `~` expansion. See
`lectorium-mcp.example.yaml`. Lookup order for the YAML:

1. `--config <path>` if explicitly given
2. `./lectorium-mcp.yaml` (or `.yml`) in the current working directory

The home directory is intentionally NOT searched — config and secrets
belong to the project, not to `$HOME`.

### Secrets via project-local `.env`

On startup the server reads `.env` from the directory of the YAML config
and from the cwd. Lines are `KEY=VALUE` (the `export ` prefix is allowed
and stripped). Existing process env always wins, so an explicit shell
export overrides whatever the file says.

Recommended layout:

```
my-project/
├── lectorium-mcp.yaml      # all settings; references ${S3_AWS_*} from .env
└── .env                    # credentials only
```

Env vars match `content-db-builder/.env.example` 1-for-1:

```
S3_AWS_BUCKET, S3_AWS_REGION, S3_AWS_ACCESS_KEY_ID, S3_AWS_SECRET_ACCESS_KEY
S3_YANDEX_BUCKET, S3_YANDEX_REGION, S3_YANDEX_ENDPOINT,
S3_YANDEX_ACCESS_KEY_ID, S3_YANDEX_SECRET_ACCESS_KEY
```

If AWS credentials are unset, the SDK falls back to its default chain
(env / shared config / SSO / IMDS).

## External dependencies

- `ffmpeg` + `ffprobe` (in PATH or set `ffmpeg.bin`)
- `whisper-cli` (whisper.cpp) — set `whisper.bin` and `whisper.model`
- `claude` CLI (Claude Code) — used for review, metadata extraction, dictionary resolution.
  Authenticate once via `claude login`. The server health-probes at startup.

## MCP tools

### Selecting a batch (one shape, every batch tool)

Every batch operation consumes the same `track.Selector` value. See
[`docs/track-selector.md`](docs/track-selector.md) for the full schema;
the short version is:

```
{
  source: registry | lake | both,        # default: both
  languages: [ru, en, hi],
  path_glob, path_prefix,
  has_pdf: true|false,                   # registry-only
  kind_tags: [morning_walk, conversation, ...],
  last_done_stage: <stage>,              # registry-only
  stage_status: {<stage>: <status>},     # registry-only
  enrich_audit: true,                    # opt-in disk read
  audit_fallback: {min_chunks: N},       # needs enrich_audit
  low_conf_min_segs: N,                  # needs enrich_audit
  size_min, size_max,
  discovered_after, discovered_before,
  limit                                  # default 1000
}
```

| Tool | Purpose |
|---|---|
| `tracks.preview` | Resolve the selector and return matching rows. Diagnostic preview before running a batch. |
| `pipeline.run` | **Async**: queue every match into the worker pool. Returns `{run_id, accepted, rejected?}`. Stages: ingest→normalize→metadata→transcribe→review→commit. |
| `pipeline.run op=audio_tag` | Per-track ID3 re-tag for every match (use `last_done_stage: committed`). |
| `pipeline.run op=align_pdf` | Per-track PDF alignment for every match (forces `has_pdf: true`). |
| `audit.summary` | Walk reviewed tracks matched by the selector and surface fallback / flag stats. Empty selector = whole corpus. |

### Per-track pipeline

| Tool | Purpose |
|---|---|
| `track.ingest` | Synchronous: hash + register one mp3, copy source to `artifacts/`. (For bulk, use `pipeline.run selector={source:lake} up_to=ingested`.) |
| `track.status` | Full pipeline state for one track |
| `track.audio.normalize` | Re-encode to 128k CBR LAME mp3 (channels preserved, no loudness processing) |
| `track.metadata.extract` | LLM extracts {date, author, location, title, refs} from filename |
| `track.transcript.create` | Run whisper.cpp on canonical mp3 |
| `track.transcript.review` | LLM proofread with frozen timestamps + chunking |
| `track.transcript.align_pdf` | PDF-canon → ASR-timing aligner (free, fast; bypasses LLM review when transcript.pdf is present) |
| `track.validate` | Read-only: which fields are missing for commit |
| `track.commit` | Validate & UPSERT track into catalog |
| `track.metadata.set` | Manual override for missing/wrong fields |
| `track.audio.tag` | Re-write ID3 tags on the public mp3 from current catalog state |
| `audit.track` | Per-track companion to `audit.summary` — chunk-level fallback / flag / low-conf detail |
| `provider.list` | Registered LLM providers |

### Run management (one shape, every async tool)

Every async tool — `pipeline.run`, `catalog.publish`, the bulk tools —
returns a `run_id`. Same four management tools cover them all:

| Tool | Purpose |
|---|---|
| `runs.list` | List active + recent runs. Defaults: `state=active+recent`, `limit=50`. Filter by `kind` / `state`. |
| `runs.status` | Snapshot of one run: state, progress (files_done, files_total, stage_breakdown), result, error. |
| `runs.wait` | Long-poll one run until terminal or timeout (default 600s, min poll interval 1s). |
| `runs.cancel` | Signal cancellation. v1 scope: queued runs flip immediately; in-flight stages (ffmpeg, whisper) finish their current step before exiting. |

### Catalog & publishing

| Tool | Purpose |
|---|---|
| `catalog.refresh` | Download latest catalog DB from CDN |
| `catalog.status` | Snapshot version + dictionary counts |
| `catalog.publish` | **Async**: bump version, copy `current.db` → `public/db/lectorium.{ver}.db`, upload `public/` and `artifacts/` to S3, merge `public/config.json`. Returns `{run_id, kind: "publish"}`. **Incremental by default** — HEAD on each S3 object, skips when size matches. Pass `force_full=true` to re-upload everything. Excludes runtime-only files (`*.db-shm`, `*.db-wal`, `*.bak-*`). |

### Dictionaries (CRUD; `author`, `location`, `source`, `tag`)

| Tool | Purpose |
|---|---|
| `<kind>_list` | Paginated list (filterable by language/query) |
| `<kind>_get` | One entry with all locales + usage_count |
| `<kind>_find` | LLM-resolve a raw string against the catalog |
| `<kind>_create` | Mint id, insert per-locale rows |
| `<kind>_update` | UPSERT one (id, language) locale |
| `<kind>_delete_locale` | Drop one locale row |
| `<kind>_delete` | Drop all locales (refused if usage_count > 0) |

## Frozen timestamps

The review pass never lets the LLM see timestamps. Each chunk is sent as
`[{idx, text}, ...]`; the response must return the same set of `idx` values.
Timestamps are reattached programmatically from the original whisper output.
On idx-set mismatch the chunk is retried; final fallback re-uses the
original text and is recorded in `review.json` under `fallback_idx`.

## Required fields for commit

`track.commit` refuses to write into the catalog without:

- `author_id`, `location_id` (resolved via catalog or set manually via
  `track.metadata.set`)
- `date` in `YYYY-MM-DD`
- `title` non-empty and not the filename fallback
- audio file present at `out/public/.../original.mp3`, duration > 0, size > 0
- transcript file present at `out/public/.../transcripts/{lang}.json`

References (scripture citations) and their `tokens` are **optional** —
conversations and walks (`kind_tag = conversation` / `morning_walk`) commit
without scripture refs. When present, each reference must resolve to a
`source_id`; `tokens` may be empty.

## Concurrency & resource limits

The daemon runs `-workers` (default 4) goroutines that pull paths off a
shared queue and run `runpipeline.UseCase` per file. Within a single file,
`track.metadata.extract` and `track.transcript.create` run in parallel via `errgroup`
after `track.audio.normalize` completes (they're independent — metadata reads
filename + ffprobe, transcribe reads the canonical mp3).

External resources are throttled via a single semaphore:

- `-transcribe-concurrency` (default 2) — caps concurrent `Transcribe()`
  calls system-wide. Matches the M-box transcriber-service worker count;
  any 5th file waits on the semaphore.
- ffmpeg `track.audio.normalize` — local CPU; no semaphore (Go scheduler + OS).
- Anthropic `track.transcript.review` — per-file `concurrency=6` chunk-level
  goroutines (legacy default); no global semaphore in v1.

Anything missing surfaces in the tool result `{ok:false, missing[], invalid[]}`
so the agent knows exactly what to fix.

## Testing

```sh
make test          # go test ./...               unit tests
make test-smoke    # go test -tags=smoke ./...   integration (need ffmpeg / network / SQLite contention)
make lint          # staticcheck ./...           advisory; install via `go install honnef.co/go/tools/cmd/staticcheck@latest`
```

Smoke tests:

- `internal/application/normalize/smoke_test.go` — ffmpeg re-encode round-trip
- `internal/application/catalog/refresh/smoke_test.go` — pull live catalog from CDN
- `internal/infra/lakeregistry/sqlite/registry_smoke_test.go` — 4-worker SetStage contention (P4-C)

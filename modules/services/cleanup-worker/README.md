# Lectorium cleanup-worker

Tiny Go service that consumes cross-service domain events from
`app.outbox` and runs the side-effects nobody else wants to own (today:
purging a deleted user's Langfuse traces; tomorrow: media S3 cleanups,
cache invalidations, …).

Pattern: **transactional outbox + choreography**. Producers (e.g. auth)
`INSERT` a row into `app.outbox` inside their own transaction; this
worker `LISTEN`s on the `outbox` channel for the push signal, and runs a
periodic `SELECT ... FOR UPDATE SKIP LOCKED` sweep as the durability
net. Postgres is the message bus — no Kafka/RabbitMQ.

## Schema dependency

This service requires migration `0023_outbox.up.sql` (introduced in
PR #607). That migration creates:

- `app.outbox` table with the columns the worker reads/updates.
- The `outbox` `pg_notify` channel (used by the trigger below).
- An `AFTER DELETE` trigger on `auth.users` that emits `user.deleted`.

The worker asserts at boot that `app.outbox` exists; if not, it exits
non-zero with a clear message pointing at the central `migrator`
container's logs.

## Events handled

| event_type      | side effect                                                  |
| --------------- | ------------------------------------------------------------ |
| `user.deleted`  | Delete all Langfuse traces tagged with the user's id (REST). |

Unknown event types are logged at `warn` and **left unprocessed** —
they're an operational bug worth inspection, not a no-op.

## Scheduled jobs

In addition to the outbox consumer loop, the worker runs in-process
crons under `internal/cron/`. These are wall-clock timers that DELETE
rows directly; the AFTER DELETE triggers from `0023_outbox.up.sql` fan
out into `app.outbox`, which the consumer loop above picks up — closed
loop, no extra wiring.

| job              | what                                                                                  | knobs                                  |
| ---------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| `anon_cleanup`   | Delete anonymous (device-only) accounts whose newest refresh_token is older than TTL. | `CLEANUP_ANON_TTL`, `CLEANUP_ANON_INTERVAL` |

On boot the cron runs one sweep immediately (so a long-down instance
catches up), then ticks every `CLEANUP_ANON_INTERVAL`. **Activity proxy
is `refresh_tokens.created_at`** — *not* `expires_at` — because auth's
RefreshTTL is 90 days; using expires_at would give a 15-month effective
idle window instead of the policy 12.

Set `CLEANUP_ANON_TTL=0` to disable the cron entirely (handy in dev /
test). The worker logs `anon_cleanup_disabled reason=CLEANUP_ANON_TTL=0`
on startup in that mode.

## Configuration

All via environment variables:

| Var                       | Required | Default | Purpose                                                                                  |
| ------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | yes      | —       | Postgres DSN (`postgres://lectorium:…@postgres:5432/lectorium`).                          |
| `CLEANUP_SWEEP_INTERVAL`  | no       | `5m`    | How often the durability-net sweep walks `app.outbox` for stragglers. Go `time.ParseDuration`. |
| `CLEANUP_ANON_TTL`        | no       | `8760h` | Idle window before an anonymous account is deleted. `0` disables the cron. Go duration (`8760h`, `30d`-style not supported). |
| `CLEANUP_ANON_INTERVAL`   | no       | `24h`   | How often the anon-cleanup cron ticks. Ignored when `CLEANUP_ANON_TTL=0`.                  |
| `PORT`                    | no       | `8090`  | Where `/healthz` listens. Keep it off the well-known service ports (auth=8081, etc).      |
| `LANGFUSE_HOST`           | no       | —       | Base URL of the self-hosted Langfuse. Empty → `user.deleted` becomes a logged no-op.       |
| `LANGFUSE_PUBLIC_KEY`     | no       | —       | Langfuse public key for basic-auth on the REST API.                                       |
| `LANGFUSE_SECRET_KEY`     | no       | —       | Langfuse secret key.                                                                      |
| `ENV`                     | no       | `dev`   | Tags every log line — Datadog routing.                                                    |
| `SERVICE_VERSION`         | no       | `dev`   | Image tag at runtime; surfaces on every log line as `version`.                            |

### A note on DB roles

PR #607's migration intentionally does **not** fan out per-role grants —
every service today connects as the single `lectorium` role and that
role owns the schema (so it implicitly has `SELECT, UPDATE, INSERT`).
If a future PR splits the stack into per-service roles, add the matching
`GRANT SELECT, UPDATE ON app.outbox TO cleanup_worker` right next to
that role's creation.

## Adding a new handler

1. Add a thin adapter file under `internal/handlers/`:
   ```go
   func MediaDeleted(s3 *s3client.Client) Handler {
       return func(ctx context.Context, evt Event) error {
           return s3.DeleteUserPrefix(ctx, evt.AggregateID)
       }
   }
   ```
2. Wire it in `cmd/cleanup-worker/main.go`:
   ```go
   reg.Register("media.deleted", handlers.MediaDeleted(s3))
   ```
3. **Idempotency is mandatory** — your handler may be invoked twice for
   the same row (worker crashed between side-effect completing and the
   `UPDATE processed_at` landing). Returning success on "already gone"
   is the rule.

## Local development

```bash
# From repo root — full dev stack including this worker.
docker compose -f infra/app/compose/docker-compose.yml \
               -f infra/app/compose/docker-compose.dev.yml \
               --env-file infra/app/.env.dev \
               up --build
```

To run the binary directly outside Docker:

```bash
export DATABASE_URL='postgres://lectorium:devpass@localhost:5432/lectorium'
go run ./cmd/cleanup-worker
```

## Tests

```bash
# Unit tests (Langfuse REST + handler registry):
go test ./...

# Integration tests against a real Postgres (skipped without DSN):
TEST_DATABASE_URL='postgres://lectorium:devpass@localhost:5432/lectorium' \
    go test ./internal/worker/...
```

## Layout

```
modules/services/cleanup-worker/
├── cmd/cleanup-worker/main.go     # entry + healthz subcommand for HEALTHCHECK
├── internal/
│   ├── config/                    # env loader
│   ├── cron/                      # scheduled jobs (anon-account cleanup, …)
│   ├── db/                        # pgxpool + outbox claim/mark queries
│   ├── handlers/                  # event_type → Handler chain
│   ├── observability/             # Langfuse REST purge client (ported from PR #604)
│   ├── logging/                   # slog JSON setup
│   └── worker/                    # LISTEN + sweep loop
├── Dockerfile                     # multi-stage → FROM scratch
├── go.mod, go.sum
└── README.md
```

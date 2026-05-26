# Shruti cleanup-worker

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

| event_type                | side effect                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------ |
| `user.deleted`            | Delete all Langfuse traces tagged with the user's id (REST).                         |
| `subscription.changed`    | Locally-emitted RC tier flip; observed for telemetry, no extra side effect today.    |
| `subscription.broadcast`  | Cross-region RC webhook fan-out: HMAC-POST each remote region's `/internal/subscription/apply`. Infinite retry per the dead-letter policy below. |

Unknown event types are logged at `warn` and **left unprocessed** —
they're an operational bug worth inspection, not a no-op.

## Scheduled jobs

In addition to the outbox consumer loop, the worker runs in-process
crons under `internal/cron/`. These are wall-clock timers that DELETE
rows directly; the AFTER DELETE triggers from `0023_outbox.up.sql` fan
out into `app.outbox`, which the consumer loop above picks up — closed
loop, no extra wiring.

| job              | what                                                                                                                                       | knobs                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `anon_cleanup`   | Delete anonymous (device-only) accounts whose newest refresh_token is older than TTL.                                                      | `CLEANUP_ANON_TTL`, `CLEANUP_ANON_INTERVAL`                                      |
| `signed_in_ttl`  | Delete signed-in users (at least one non-device identity) whose newest refresh_token is older than TTL. Defaults to dry-run on first deploy. | `CLEANUP_SIGNED_IN_TTL`, `CLEANUP_SIGNED_IN_INTERVAL`, `CLEANUP_SIGNED_IN_DRY_RUN` |

On boot each cron runs one sweep immediately (so a long-down instance
catches up), then ticks at its interval. **Activity proxy is
`refresh_tokens.created_at`** — *not* `expires_at` — because auth's
RefreshTTL is 90 days; using expires_at would give a 15-month effective
idle window instead of the policy 12 / 24.

Set `CLEANUP_ANON_TTL=0` or `CLEANUP_SIGNED_IN_TTL=0` to disable the
respective cron entirely (handy in dev / test). The worker logs
`*_disabled reason=…` on startup in that mode.

### Signed-in TTL dry-run

`signed_in_ttl` ships with `CLEANUP_SIGNED_IN_DRY_RUN=true` as the
default. In dry-run mode the cron runs the same selection predicate as
a SELECT and logs every would-delete user id — but never DELETEs. The
operator should:

1. Deploy with the default. Wait 1-2 weeks.
2. Inspect `signed_in_ttl_dryrun_user user_id=…` log lines for false
   positives (e.g. test accounts you want to keep, internal users).
3. When the would-delete set looks sensible, flip
   `CLEANUP_SIGNED_IN_DRY_RUN=false` and redeploy.

Same outbox-event path as `anon_cleanup`: DELETE on `auth.users` →
`AFTER DELETE` trigger → `user.deleted` row in `app.outbox` → Langfuse
purge handler picks it up.

## Dead-letter policy

This worker drains `app.outbox` with **infinite retry** — events never
move to a dead-letter table, never get dropped. Justification:

- Outbox events represent durable user-visible state (`user.deleted`,
  `subscription.changed`, `subscription.broadcast`). Dropping them
  silently produces orphan state on other regions.
- The cost of unbounded retry is bounded: one row per stuck event,
  Postgres handles millions of rows cheaply, the
  `outbox_unprocessed_idx` partial index keeps `WHERE processed_at IS
  NULL` cheap regardless of processed-row volume.
- The Grafana alert `outbox_dead_letter` fires after 1h of stuck-state
  via Prometheus → Telegram, surfacing the issue to the operator. See
  `infra/observability/compose/grafana/provisioning/alerting/rules.yml`.
- The operator decides remediation: drop the row manually (`DELETE
  FROM app.outbox WHERE id = $1`), fix the destination, or wait.

The gauge backing the alert is `shruti_outbox_pending_seconds`,
labelled by `event_type`, polled every 30s from the worker's DB pool
and exposed on `/metrics` (same port as `/healthz`).

## Configuration

All via environment variables:

| Var                       | Required | Default | Purpose                                                                                  |
| ------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | yes      | —       | Postgres DSN (`postgres://shruti:…@postgres:5432/shruti`).                          |
| `CLEANUP_SWEEP_INTERVAL`  | no       | `5m`    | How often the durability-net sweep walks `app.outbox` for stragglers. Go `time.ParseDuration`. |
| `CLEANUP_ANON_TTL`        | no       | `8760h` | Idle window before an anonymous account is deleted. `0` disables the cron. Go duration (`8760h`, `30d`-style not supported). |
| `CLEANUP_ANON_INTERVAL`   | no       | `24h`   | How often the anon-cleanup cron ticks. Ignored when `CLEANUP_ANON_TTL=0`.                  |
| `CLEANUP_SIGNED_IN_TTL`     | no       | `17520h`(~24mo) | Idle window before a signed-in account is deleted. `0` disables. Predicate: has a non-device identity AND no refresh_token created within TTL. |
| `CLEANUP_SIGNED_IN_INTERVAL`| no       | `24h`   | Tick rate for the signed-in TTL cron. Ignored when `CLEANUP_SIGNED_IN_TTL=0`.              |
| `CLEANUP_SIGNED_IN_DRY_RUN` | no       | `true`  | Safety default. When `true` the cron logs would-delete ids but does not DELETE. Flip to `false` after 1-2 weeks of stable would-delete output. |
| `PORT`                    | no       | `8090`  | Where `/healthz` and `/metrics` listen. Keep off well-known service ports (auth=8081, etc). |
| `LANGFUSE_HOST`           | no       | —       | Base URL of the self-hosted Langfuse. Empty → `user.deleted` becomes a logged no-op.       |
| `LANGFUSE_PUBLIC_KEY`     | no       | —       | Langfuse public key for basic-auth on the REST API.                                       |
| `LANGFUSE_SECRET_KEY`     | no       | —       | Langfuse secret key.                                                                      |
| `ENV`                     | no       | `dev`   | Tags every log line — Datadog routing.                                                    |
| `SERVICE_VERSION`         | no       | `dev`   | Image tag at runtime; surfaces on every log line as `version`.                            |

### A note on DB roles

PR #607's migration intentionally does **not** fan out per-role grants —
every service today connects as the single `shruti` role and that
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
export DATABASE_URL='postgres://shruti:devpass@localhost:5432/shruti'
go run ./cmd/cleanup-worker
```

## Tests

```bash
# Unit tests (Langfuse REST + handler registry):
go test ./...

# Integration tests against a real Postgres (skipped without DSN):
TEST_DATABASE_URL='postgres://shruti:devpass@localhost:5432/shruti' \
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

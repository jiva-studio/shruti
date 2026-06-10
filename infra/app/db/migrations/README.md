# shruti DB migrations

Single source of truth for the schema of the `shruti` postgres database.
Applied at boot by the `migrator` compose service (golang-migrate/migrate).
Service containers (auth, chat, share-video) wait for migrator via
`depends_on: service_completed_successfully` — they never run migrations
themselves, only do an `assertSchemaReady(...)` probe and exit 1 with a
structured message if the expected tables are missing.

## File numbering

| Range | Owner | Purpose |
|-------|-------|---------|
| `0001_auth_*` | auth | The `auth.*` schema (users, identities, refresh_tokens) |
| `0010_chat_*` to `0019_chat_*` | chat | Chat tables in `public.*` (chunks, indexed_items, db_state, usage, indexer_runs, attributions, attribution_embeddings) |
| `0020_*` | shared | Cross-service objects. First is `public.tasks` (used by share-video) |

Leave gaps in the numbering when adding new initial-set files; future
incremental migrations get slot `<existing>+1` in the relevant range.

## Adding a migration

1. Pick the next free number in the appropriate range. `ls` this directory
   and take `max + 1` — golang-migrate refuses to load a source with a
   duplicate version number (`duplicate migration file: …`), which fails
   the migrator and blocks every service that waits on it.
2. Create `<NNNN>_<descriptive_name>.up.sql` (forward) and optionally
   `<NNNN>_<descriptive_name>.down.sql` (reversal).
3. Test locally: `docker compose up migrator`, then verify schema with
   `\d <table>` in a psql session.
4. Push. The migrations are **baked into the `shruti-migrator` image**
   (`infra/app/db/Dockerfile`) — there is no bind-mount and no rsync. CI
   (`services-ghcr.yml`) rebuilds and pushes that image on any change under
   `infra/app/db/migrations/**` or the Dockerfile.
5. On prod, Watchtower (`--include-stopped --revive-stopped`) pulls the new
   migrator image and re-runs the one-shot `migrator` container, which
   applies your new file and exits 0; the service containers
   (`depends_on: service_completed_successfully`) then start.

## Dirty state recovery

If a migration fails mid-apply (constraint violation, syntax error, OOM),
golang-migrate marks the version DIRTY in `schema_migrations`. Subsequent
runs of `up` refuse to proceed.

```bash
# On the VPS:
docker compose -p shruti run --rm migrator force <N>   # after manual SQL fixup
docker compose -p shruti up -d migrator                 # retry apply
```

Don't auto-recover; investigate first.

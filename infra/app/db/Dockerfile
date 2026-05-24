# Migrator image — wraps the upstream golang-migrate CLI with the SQL
# migrations baked in. The bind-mount of `../db/migrations:/migrations:ro`
# is dropped from docker-compose.yml; migrations now travel inside the
# image, so a schema change reaches prod through the same CI flow as
# any code change.
#
# Build context is ./infra/app/db (see .github/workflows/services-ghcr.yml).
# The upstream image already declares `migrate` as ENTRYPOINT, so the
# compose service keeps passing CLI flags via `command:`.

FROM migrate/migrate:v4.18.1
COPY migrations /migrations

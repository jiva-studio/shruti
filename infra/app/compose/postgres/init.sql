-- Postgres bootstrap for the shruti chat-stack.
--
-- Mounted into /docker-entrypoint-initdb.d/ inside the pgvector image.
-- The image runs this file ONLY on a fresh data volume (first
-- `docker compose up` of postgres after `docker volume rm pgdata`).
-- On an existing prod volume, init scripts are skipped — see
-- infra/observability-agent/README.md "Postgres bootstrap (b)" for the
-- manual retrofit path via `docker exec`.
--
-- Path note (Stream A coordination): this file lives at
--   infra/app/compose/postgres/init.sql
-- which is where it WILL live after Stream A renames infra/compose/ to
-- infra/app/compose/. Until that rename happens, copy/symlink it into
-- infra/compose/postgres/ in your local working tree if you need the
-- mount to take effect on a fresh deploy. The migration target is
-- infra/app/ — that's the canonical location going forward.
--
-- The PASSWORD placeholder __REPLACE_AT_DEPLOY__ is templated by
-- infra/app/scripts/deploy.sh (Stream A) before the volume is mounted —
-- the templated copy lives outside the repo on the host. We never
-- commit a real password.

-- 1. pg_stat_statements gives postgres-exporter per-query statistics
--    (calls, mean time, p95). Requires shared_preload_libraries=
--    pg_stat_statements set in postgresql.conf (chat-stack compose
--    will need to pass this via `-c shared_preload_libraries=...` once
--    the rebrand lands — until then the manual `ALTER SYSTEM` + restart
--    path covers it).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 2. Dedicated read-only role for postgres-exporter. pg_monitor is a
--    Postgres-builtin role that grants exactly what the exporter needs:
--    SELECT on pg_stat_*, pg_catalog, pg_stat_statements — no data access.
--    DO block makes the role-creation idempotent across re-runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_exporter') THEN
    CREATE USER pg_exporter WITH PASSWORD '__REPLACE_AT_DEPLOY__';
  END IF;
END
$$;

GRANT pg_monitor TO pg_exporter;

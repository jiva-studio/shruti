-- Postgres bootstrap for the shruti chat-stack.
-- Mounted into /docker-entrypoint-initdb.d/ on a fresh data volume.
-- On existing volumes apply manually via `docker exec ... psql`.
-- Replace __REPLACE_AT_DEPLOY__ with the value of PG_EXPORTER_PASSWORD
-- from the operator's secrets file before sourcing.

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Role name avoids the reserved pg_* namespace.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shruti_exporter') THEN
    CREATE USER shruti_exporter WITH PASSWORD '__REPLACE_AT_DEPLOY__';
  END IF;
END
$$;

GRANT pg_monitor TO shruti_exporter;

-- Custom queries in observability-agent/compose/postgres-queries.yaml
-- read public.tasks for share-video queue depth — pg_monitor does not
-- cover user tables, so grant SELECT explicitly.
GRANT SELECT ON public.tasks TO shruti_exporter;

-- Same exporter also reads app.outbox to count rows the cleanup-worker
-- has not stamped processed_at on yet (cleanup-worker stuck / Langfuse
-- unreachable alarm). Needs USAGE on the schema in addition to SELECT
-- on the table — app schema is created by migration 0023, not by this
-- bootstrap, so existing prod volumes need both GRANTs applied manually
-- (see observability-agent/README.md, "Existing prod volume" section).
GRANT USAGE ON SCHEMA app TO shruti_exporter;
GRANT SELECT ON app.outbox TO shruti_exporter;

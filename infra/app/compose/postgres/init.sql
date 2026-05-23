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

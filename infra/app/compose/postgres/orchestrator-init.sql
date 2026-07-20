-- Postgres bootstrap for the ORCHESTRATOR database.
-- Mounted into /docker-entrypoint-initdb.d/ on a fresh data volume.
-- On existing volumes apply manually via `docker exec ... psql`.
-- Replace __REPLACE_AT_DEPLOY__ with the value of
-- ORCHESTRATOR_PG_EXPORTER_PASSWORD from the operator's secrets file before
-- sourcing.
--
-- Separate from postgres/init.sql because the orchestrator owns its own
-- Postgres instance: the app exporter's connection cannot see these tables at
-- all, so monitoring the ingest pipeline needs its own role here.
--
-- ORDERING PROBLEM this file solves: initdb scripts run on an EMPTY database,
-- before the service has ever started, so the `orchestrator` schema and its
-- tables do not exist yet. A plain `GRANT SELECT ON orchestrator.jobs` would
-- therefore fail — and a failing initdb script aborts Postgres startup
-- entirely, taking the whole stack with it. So every schema-dependent grant is
-- either guarded or expressed as a DEFAULT privilege that applies to tables
-- created later. This script is idempotent and safe to re-run by hand.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shruti_exporter') THEN
    CREATE USER shruti_exporter WITH PASSWORD '__REPLACE_AT_DEPLOY__';
  END IF;
END
$$;

GRANT pg_monitor TO shruti_exporter;

-- Covers objects the migrator creates AFTER this script runs. The orchestrator
-- service connects as the `orchestrator` role, so anything it creates later
-- inherits these grants and no manual follow-up is needed on a fresh volume.
--
-- BOTH lines are required. Table privileges alone are not enough: reading a
-- table also needs USAGE on its schema, and the schema does not exist yet
-- either — so it needs its own default-privilege grant. Verified against a real
-- postgres:16 by creating the schema afterwards and reading as the role.
ALTER DEFAULT PRIVILEGES FOR ROLE orchestrator
  GRANT USAGE ON SCHEMAS TO shruti_exporter;
ALTER DEFAULT PRIVILEGES FOR ROLE orchestrator
  GRANT SELECT ON TABLES TO shruti_exporter;

-- Covers the re-run case (existing volume, migrations already applied), where
-- the default privileges above came too late. Guarded so the fresh-volume run
-- is a no-op rather than an error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata
              WHERE schema_name = 'orchestrator') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA orchestrator TO shruti_exporter';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA orchestrator TO shruti_exporter';
  END IF;
END
$$;

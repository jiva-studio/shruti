#!/bin/sh
# Postgres bootstrap for the ORCHESTRATOR database.
# Mounted into /docker-entrypoint-initdb.d/ and run by the postgres entrypoint
# on a FRESH data volume. On an existing volume run it by hand:
#
#   docker compose exec -e ORCHESTRATOR_PG_EXPORTER_PASSWORD=<pw> \
#     orchestrator-postgres /docker-entrypoint-initdb.d/10-exporter.sh
#
# Creates the read-only role the orchestrator postgres-exporter connects as.
# Without it the ingest alerts read no data while looking perfectly healthy.
#
# WHY A SHELL SCRIPT AND NOT PLAIN .sql: the password has to come from the
# operator's .env at runtime. A .sql file cannot read the environment, and the
# earlier template-with-a-placeholder approach was silently broken — nothing
# substituted the placeholder, and `deploy.sh` rsyncs this directory with
# --delete, so editing it on the host would be reverted on the next deploy. The
# role would have been created with the literal placeholder as its password
# while the exporter authenticated with the real one.
#
# Separate from postgres/init.sql because the orchestrator owns its own
# Postgres instance: the app exporter's connection cannot see these tables at
# all, so monitoring the ingest pipeline needs its own role here.

set -eu

: "${ORCHESTRATOR_PG_EXPORTER_PASSWORD:?must be set on the orchestrator-postgres container (from .env)}"

# ORDERING PROBLEM the SQL below solves: initdb scripts run on an EMPTY
# database, before the service has ever started, so the `orchestrator` schema
# and its tables do not exist yet. A plain `GRANT SELECT ON orchestrator.jobs`
# would therefore fail — and a failing initdb script aborts Postgres startup
# entirely, taking the whole stack with it. So every schema-dependent grant is
# either guarded or expressed as a DEFAULT privilege that applies to tables
# created later. Idempotent: safe to re-run by hand.
psql -v ON_ERROR_STOP=1 \
     -v pw="$ORCHESTRATOR_PG_EXPORTER_PASSWORD" \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" <<'EOSQL'

-- Create only when absent; \gexec runs the SELECT's result as a statement.
SELECT 'CREATE USER lectorium_exporter'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lectorium_exporter')\gexec

-- Always set the password: makes the script idempotent AND makes a rotation a
-- matter of re-running it. :'pw' is quoted by psql, so odd characters are safe.
ALTER USER lectorium_exporter WITH PASSWORD :'pw';

GRANT pg_monitor TO lectorium_exporter;

-- Covers objects the migrator creates AFTER this script runs. The orchestrator
-- service connects as the `orchestrator` role, so anything it creates later
-- inherits these grants and no manual follow-up is needed on a fresh volume.
--
-- BOTH lines are required. Table privileges alone are not enough: reading a
-- table also needs USAGE on its schema, and the schema does not exist yet
-- either — so it needs its own default-privilege grant. Verified against a real
-- postgres:16 by creating the schema afterwards and reading as the role.
ALTER DEFAULT PRIVILEGES FOR ROLE orchestrator
  GRANT USAGE ON SCHEMAS TO lectorium_exporter;
ALTER DEFAULT PRIVILEGES FOR ROLE orchestrator
  GRANT SELECT ON TABLES TO lectorium_exporter;

-- Covers the re-run case (existing volume, migrations already applied), where
-- the default privileges above came too late. Guarded so the fresh-volume run
-- is a no-op rather than an error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata
              WHERE schema_name = 'orchestrator') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA orchestrator TO lectorium_exporter';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA orchestrator TO lectorium_exporter';
  END IF;
END
$$;

EOSQL

echo "orchestrator-init: lectorium_exporter ready"

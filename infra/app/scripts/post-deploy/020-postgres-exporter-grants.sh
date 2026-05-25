#!/usr/bin/env bash
# Grant postgres-exporter read access on any new schema/table it needs to
# expose as a metric. Required because init.sql only runs on first-time
# volume bootstrap — existing prod databases don't get re-initialised
# when we add new metrics. GRANT is idempotent.
#
# Currently grants:
#   - SELECT on app.outbox  (feeds lectorium_outbox_unprocessed_count
#     used by the cleanup_worker_outbox_stuck Grafana alert)
set -euo pipefail

cd "$(dirname "$0")/../../../.."

docker compose -f infra/app/compose/docker-compose.yml exec -T postgres \
  psql -U lectorium -d lectorium -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA app TO lectorium_exporter;
GRANT SELECT ON app.outbox TO lectorium_exporter;
SQL

echo "→ postgres-exporter grants applied"

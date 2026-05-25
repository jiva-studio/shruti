#!/usr/bin/env bash
# Grant postgres-exporter read access on any new schema/table it needs to
# expose as a metric. Required because init.sql only runs on first-time
# volume bootstrap — existing prod databases don't get re-initialised
# when we add new metrics. GRANT is idempotent.
#
# Currently grants:
#   - SELECT on app.outbox  (feeds lectorium_outbox_unprocessed_count
#     used by the cleanup_worker_outbox_stuck Grafana alert)
#   - SELECT on auth.users + auth.rc_webhook_events (feeds the
#     subscription-tier metrics: lectorium_subscription_tier_count,
#     lectorium_rc_webhook_unprocessed_count,
#     lectorium_subscription_tier_stale_count — Phase 9)
#
# Uses `docker exec` directly (not `docker compose exec`) so the hook
# doesn't need LECTORIUM_POSTGRES_PASSWORD in its env — compose would
# re-evaluate the full service graph and fail to interpolate, but the
# container itself is already running with credentials baked in.
set -euo pipefail

docker exec -i lectorium-postgres-1 \
  psql -U lectorium -d lectorium -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA app TO lectorium_exporter;
GRANT SELECT ON app.outbox TO lectorium_exporter;
GRANT USAGE ON SCHEMA auth TO lectorium_exporter;
GRANT SELECT ON auth.users TO lectorium_exporter;
GRANT SELECT ON auth.rc_webhook_events TO lectorium_exporter;
SQL

echo "→ postgres-exporter grants applied"

#!/usr/bin/env bash
# Grant postgres-exporter read access on any new schema/table it needs to
# expose as a metric. Required because init.sql only runs on first-time
# volume bootstrap — existing prod databases don't get re-initialised
# when we add new metrics. GRANT is idempotent.
#
# Currently grants:
#   - SELECT on app.outbox  (feeds shruti_outbox_unprocessed_count
#     used by the cleanup_worker_outbox_stuck Grafana alert)
#   - SELECT on auth.users + auth.rc_webhook_events (feeds the
#     subscription-tier metrics: shruti_subscription_tier_count,
#     shruti_rc_webhook_unprocessed_count,
#     shruti_subscription_tier_stale_count — Phase 9)
#
# Uses `docker exec` directly (not `docker compose exec`) so the hook
# doesn't need SHRUTI_POSTGRES_PASSWORD in its env — compose would
# re-evaluate the full service graph and fail to interpolate, but the
# container itself is already running with credentials baked in.
set -euo pipefail

docker exec -i shruti-postgres-1 \
  psql -U shruti -d shruti -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA app TO shruti_exporter;
GRANT SELECT ON app.outbox TO shruti_exporter;
GRANT USAGE ON SCHEMA auth TO shruti_exporter;
GRANT SELECT ON auth.users TO shruti_exporter;
GRANT SELECT ON auth.rc_webhook_events TO shruti_exporter;
SQL

echo "→ postgres-exporter grants applied"

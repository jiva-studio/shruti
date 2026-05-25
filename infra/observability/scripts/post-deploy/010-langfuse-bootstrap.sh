#!/usr/bin/env bash
# infra/observability/scripts/post-deploy/010-langfuse-bootstrap.sh
#
# Re-assert the 90-day TTL on the Langfuse ClickHouse tables on every deploy
# so retention drift becomes impossible. `ALTER TABLE … MODIFY TTL` is
# metadata-only when the TTL expression is unchanged, so this is a true
# no-op on steady-state deploys.
#
# Contract: see infra/observability/scripts/post-deploy/README.md
#   - runs on the obs host (invoked over SSH by deploy.sh)
#   - self-contained: no library sourcing, no env vars from the operator
#   - idempotent at the ClickHouse engine level
#   - exits non-zero on real failure (deploy halts → operator fixes
#     ClickHouse before retrying); better than a silent skip on drift
#
# Container naming: docker compose v2 with `name: lectorium-observability`
# produces `lectorium-observability-<service>-1`. The Langfuse tables live
# in the `default` ClickHouse database (despite CLICKHOUSE_DB=langfuse in
# compose, Langfuse v3 migrations target `default`).
set -euo pipefail

docker exec -i lectorium-observability-clickhouse-1 \
  clickhouse-client --multiquery <<'SQL'
ALTER TABLE default.traces       MODIFY TTL toDateTime(timestamp)  + INTERVAL 90 DAY DELETE;
ALTER TABLE default.observations MODIFY TTL toDateTime(start_time) + INTERVAL 90 DAY DELETE;
ALTER TABLE default.scores       MODIFY TTL toDateTime(timestamp)  + INTERVAL 90 DAY DELETE;
ALTER TABLE default.event_log    MODIFY TTL toDateTime(created_at) + INTERVAL 90 DAY DELETE;
SQL

echo "→ Langfuse ClickHouse TTL re-asserted (90 days)"

#!/usr/bin/env bash
# infra/observability/scripts/lib/bootstrap-langfuse-ttl.sh
#
# Apply a 90-day TTL on the Langfuse ClickHouse tables so trace data rotates
# out automatically. This is the corpus-wide safety-net retention policy that
# complements the per-user purge issued through the Langfuse API when an
# account is deleted (see auth-service): even if that API call fails, every
# trace row tied to a deleted user disappears within 90 days.
#
# Why ClickHouse-native TTL and not Langfuse project retention?
#   Langfuse OSS (self-hosted) exposes project-level retention only behind an
#   enterprise license. The underlying ClickHouse tables, however, are plain
#   MergeTree / ReplacingMergeTree and support `MODIFY TTL` natively.
#
# Tables + timestamp columns (verified against upstream Langfuse migrations
# in packages/shared/clickhouse/migrations/unclustered):
#   - traces        → timestamp     (DateTime64(3))   partitioned by month
#   - observations  → start_time    (DateTime64(3))   partitioned by month
#   - scores        → timestamp     (DateTime64(3))   partitioned by month
#   - event_log     → created_at    (DateTime64(3))   no time partition
#
# `ALTER TABLE … MODIFY TTL` is naturally idempotent in ClickHouse: re-issuing
# the same TTL expression is a metadata-only no-op once it is already set, so
# this step is safe to run on every deploy.
#
# Required env (set by configure.sh):
#   REGION, REMOTE_DIR
# shellcheck shell=bash

# Edit here if the retention window needs to change; document the new value
# in infra/observability/README.md → "Langfuse data retention" too.
LANGFUSE_TTL_DAYS="${LANGFUSE_TTL_DAYS:-90}"

bootstrap_langfuse_ttl() {
  require_vars REGION REMOTE_DIR || return 1

  # Langfuse OSS writes its ClickHouse tables to the `default` database, not
  # to a `langfuse`-named one — verified via SHOW CREATE TABLE on prod. The
  # earlier `langfuse` value caused the existence-precheck below to never
  # match, so this routine silently no-op'd on every deploy.
  local db="default"
  local days="$LANGFUSE_TTL_DAYS"

  log "Applying ${days}-day TTL on Langfuse ClickHouse tables (db=${db})"

  # Wait until clickhouse is up AND the four tables exist — on a brand-new
  # deploy Langfuse migrations may still be running when configure.sh fires.
  local i ready=0
  for i in $(seq 1 60); do
    if ssh_run "docker exec clickhouse clickhouse-client --query \
        \"SELECT count() FROM system.tables WHERE database='${db}' AND name IN ('traces','observations','scores','event_log')\" \
        2>/dev/null | grep -qx '4'"; then
      ready=1
      break
    fi
    sleep 4
  done
  if [ "$ready" -ne 1 ]; then
    warn "ClickHouse tables not all present yet — skipping TTL apply (re-run configure.sh once Langfuse migrations finish)"
    return 0
  fi

  # Each entry: <table>:<timestamp_column>
  local specs=(
    "traces:timestamp"
    "observations:start_time"
    "scores:timestamp"
    "event_log:created_at"
  )

  local spec table col sql
  for spec in "${specs[@]}"; do
    table="${spec%%:*}"
    col="${spec#*:}"
    sql="ALTER TABLE ${db}.${table} MODIFY TTL toDateTime(${col}) + INTERVAL ${days} DAY DELETE"
    log "  · ${table} (${col}) → ${days}d"
    if ! ssh_run "docker exec clickhouse clickhouse-client --query \"${sql}\"" >/dev/null 2>&1; then
      warn "    failed to set TTL on ${table} — see: docker exec clickhouse clickhouse-client --query \"${sql}\""
    fi
  done

  ok "Langfuse TTL (${days}d) applied"
}

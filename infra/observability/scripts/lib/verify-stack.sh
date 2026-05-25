#!/usr/bin/env bash
# infra/observability/scripts/lib/verify-stack.sh
#
# 10-point smoke verification after deploy + configure. Each check is a
# single curl with a small timeout — collect failures and fail the whole
# function only at the end so the operator sees the full picture.
# shellcheck shell=bash

verify_stack() {
  require_vars OBS_TS_IP TAILNET_DOMAIN REMOTE_DIR || return 1
  log "Smoke verification (10 checks)..."

  local failed=0
  # Reachable from the obs host's network namespace.
  # NOTE: caddy admin (2019), prometheus (9090) and loki host-localhost
  # (3100) are NOT host-bound — those go through `compose exec` below.
  local checks=(
    "loki tailscale ingest|http://${OBS_TS_IP}:3100/ready"
    "grafana via caddy|https://grafana.${TAILNET_DOMAIN}/api/health"
    "langfuse via caddy|https://langfuse.${TAILNET_DOMAIN}/api/public/health"
    "langfuse tailscale ingest|http://${OBS_TS_IP}:3001/api/public/health"
    "prometheus via caddy|https://prometheus.${TAILNET_DOMAIN}/-/ready"
  )

  local entry name url
  for entry in "${checks[@]}"; do
    name="${entry%%|*}"
    url="${entry#*|}"
    if ssh_run "curl -fs --max-time 5 -o /dev/null '$url'"; then
      ok "  $name"
    else
      warn "  $name — FAILED ($url)"
      failed=$((failed + 1))
    fi
  done

  # Container-internal checks. Use `docker compose exec` from the compose
  # dir so service names resolve regardless of compose's container-name
  # mangling (the real container is `lectorium-observability-<svc>-1`,
  # `docker exec <short-name>` would NOT find it).
  local compose_remote="cd '$REMOTE_DIR/compose' && DOCKER_CONFIG='$REMOTE_DIR/config' docker compose"

  local container_checks=(
    "caddy listening on :443|caddy|sh -c 'nc -z localhost 443'"
    "prometheus ready|prometheus|wget --spider -q http://localhost:9090/-/ready"
    "loki ready|loki|wget --spider -q http://localhost:3100/ready"
    "grafana container internal|grafana|wget --spider -q http://localhost:3000/api/health"
    "langfuse-web container internal|langfuse-web|wget --spider -q http://localhost:3000/api/public/health"
  )

  local cc cname svc cmd
  for cc in "${container_checks[@]}"; do
    cname="${cc%%|*}"
    svc="${cc#*|}"; svc="${svc%%|*}"
    cmd="${cc##*|}"
    if ssh_run "$compose_remote exec -T $svc $cmd"; then
      ok "  $cname"
    else
      warn "  $cname — FAILED ($svc: $cmd)"
      failed=$((failed + 1))
    fi
  done

  if [ "$failed" -gt 0 ]; then
    warn "verify-stack: $failed check(s) failed"
    return 1
  fi
  ok "All 10 checks passed"
}

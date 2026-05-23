#!/usr/bin/env bash
# infra/observability/scripts/lib/verify-stack.sh
#
# 10-point smoke verification after deploy + configure. Each check is a
# single curl with a small timeout — collect failures and fail the whole
# function only at the end so the operator sees the full picture.
# shellcheck shell=bash

verify_stack() {
  require_vars OBS_TS_IP TAILNET_DOMAIN || return 1
  log "Smoke verification (10 checks)..."

  local failed=0
  local checks=(
    "caddy admin API|http://localhost:2019/config/"
    "prometheus ready|http://localhost:9090/-/ready"
    "loki ready|http://localhost:3100/ready"
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

  # Container-internal checks (Grafana / Langfuse cannot be reached on
  # localhost from the host because they're behind Caddy + docker net).
  if ssh_run "docker exec grafana wget --spider -q http://localhost:3000/api/health"; then
    ok "  grafana container internal"
  else
    warn "  grafana container internal — FAILED"
    failed=$((failed + 1))
  fi

  if ssh_run "docker exec langfuse-web wget --spider -q http://localhost:3000/api/public/health"; then
    ok "  langfuse-web container internal"
  else
    warn "  langfuse-web container internal — FAILED"
    failed=$((failed + 1))
  fi

  if [ "$failed" -gt 0 ]; then
    warn "verify-stack: $failed check(s) failed"
    return 1
  fi
  ok "All 10 checks passed"
}

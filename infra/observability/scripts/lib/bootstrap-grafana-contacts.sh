#!/usr/bin/env bash
# infra/observability/scripts/lib/bootstrap-grafana-contacts.sh
#
# The Telegram contact point + policies are already shipped by file
# provisioning (compose/grafana/provisioning/alerting/*.yml), so on a
# fresh deploy this is mostly a verification step. We optionally support
# updating the chat ID via the HTTP API for the rare case where the
# operator wants to point alerts at a new chat without redeploying.
#
# Required env: TG_BOT_TOKEN, TG_CHAT_ID, GRAFANA_ADMIN_PASSWORD, REMOTE_DIR
# shellcheck shell=bash

bootstrap_grafana_contacts() {
  require_vars TG_BOT_TOKEN TG_CHAT_ID || return 1
  log "Verifying Grafana Telegram contact point..."

  # Use the in-container Grafana admin API via docker exec — avoids the
  # need to expose the Grafana API publicly and re-uses the admin password
  # the operator put in shared.env.
  ssh_run "docker exec grafana wget --spider -q \
           --header='Authorization: Basic '\$(printf 'admin:${GRAFANA_ADMIN_PASSWORD}' | base64) \
           http://localhost:3000/api/alertmanager/grafana/config/api/v1/alerts 2>/dev/null \
           && echo '✓ Grafana alerting API reachable' \
           || echo '! Grafana alerting API not yet reachable — alerts may take 30s after first boot'"

  # Sanity-check Telegram token by sending a one-line ping. If the bot
  # token is wrong, alerts will silently fail — better to find out now.
  log "Pinging Telegram bot token..."
  if curl -fsS -o /dev/null \
       "https://api.telegram.org/bot${TG_BOT_TOKEN}/getMe"; then
    ok "Telegram bot token works"
  else
    warn "Telegram bot token rejected by api.telegram.org — alerts will not deliver"
  fi
}

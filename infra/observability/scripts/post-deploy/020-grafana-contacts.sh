#!/usr/bin/env bash
# infra/observability/scripts/post-deploy/020-grafana-contacts.sh
#
# Re-verify the Grafana Telegram contact point on every deploy. The canonical
# config lives in Grafana file provisioning
# (compose/grafana/provisioning/alerting/*.yml) and is re-loaded on each
# container restart; this hook is a defence-in-depth re-check so a wedged bot
# token or stale chat ID is caught at deploy time rather than the next time
# an alert fires.
#
# Contract: see infra/observability/scripts/post-deploy/README.md
#   - runs on the obs host (invoked over SSH by deploy.sh)
#   - self-contained: reads secrets from the runtime compose/.env on the host
#   - idempotent: verification only (file provisioning owns the actual config)
#   - exits 0 if Grafana isn't yet reachable (warns) — provisioning still
#     applies regardless; non-zero only on a structural failure
set -euo pipefail

# Resolve to the deployed layout: scripts/post-deploy/../../compose/.env
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$HERE/../../compose/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ 020-grafana-contacts: $ENV_FILE missing (deploy.sh must have written it)" >&2
  exit 1
fi

# shellcheck source=/dev/null
set -a; source "$ENV_FILE"; set +a

: "${GRAFANA_ADMIN_PASSWORD:?missing in compose/.env}"
: "${TG_BOT_TOKEN:?missing in compose/.env}"

# Wait briefly for Grafana to be answering inside the container — provisioning
# can take 20-30s on a cold start. Bail with a clear message rather than
# halting the deploy if Grafana never comes up; the contact point is shipped
# by file provisioning regardless of whether this verification runs.
echo "→ post-deploy/020: waiting for Grafana to be reachable"
ready=0
for _ in $(seq 1 30); do
  if docker exec lectorium-observability-grafana-1 \
       wget --spider -q http://localhost:3000/api/health 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  echo "! post-deploy/020: Grafana not reachable after 60s — contact point check skipped (file provisioning still applies)" >&2
  exit 0
fi

# Probe the alerting API with the admin password to confirm Grafana hasn't
# wedged on an unreadable provisioning file. Run the auth + request entirely
# inside the container so the password never crosses a shell quote on the
# host.
echo "→ post-deploy/020: probing Grafana alerting API"
if docker exec -e GF_PASS="$GRAFANA_ADMIN_PASSWORD" \
     lectorium-observability-grafana-1 \
     sh -c 'wget --spider -q \
       --header="Authorization: Basic $(printf "admin:%s" "$GF_PASS" | base64 -w0)" \
       http://localhost:3000/api/alertmanager/grafana/config/api/v1/alerts' \
     2>/dev/null; then
  echo "✓ Grafana alerting API reachable"
else
  echo "! Grafana alerting API not yet reachable — alerts may take 30s after first boot" >&2
fi

# Sanity-check Telegram token by hitting getMe. If the bot token is wrong,
# alerts will silently fail — better to find out at deploy time.
echo "→ post-deploy/020: pinging Telegram bot token"
if curl -fsS -o /dev/null --max-time 10 \
     "https://api.telegram.org/bot${TG_BOT_TOKEN}/getMe"; then
  echo "✓ Telegram bot token works"
else
  echo "! Telegram bot token rejected by api.telegram.org — alerts will not deliver" >&2
fi

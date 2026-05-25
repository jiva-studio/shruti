#!/usr/bin/env bash
# infra/observability/scripts/post-deploy/020-grafana-contacts.sh
#
# Re-verifies the Grafana Telegram contact point on every deploy. The
# canonical config lives in Grafana file provisioning
# (compose/grafana/provisioning/alerting/*.yml) and is re-loaded on each
# container restart; this hook is a defence-in-depth re-check so a wedged
# bot token or stale chat ID is caught at deploy time rather than the next
# time an alert fires.
#
# Contract: see infra/observability/scripts/post-deploy/README.md
#   - idempotent (verification only; updates only on operator-driven changes)
#   - self-skips when Grafana isn't yet reachable (warns, returns 0)
#   - exits non-zero only on a structural failure (lib missing, env unset)
#
# Required env (set by deploy.sh before invocation):
#   SSH_TARGET, SSH_OPTS, REMOTE_DIR, TG_BOT_TOKEN, TG_CHAT_ID, GRAFANA_ADMIN_PASSWORD
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_LIB="$(cd "$HERE/../../../shared/lib" && pwd)"
OBS_LIB="$(cd "$HERE/../lib" && pwd)"

# shellcheck source=../../../shared/lib/deploy-common.sh
source "$SHARED_LIB/deploy-common.sh"

require_vars SSH_TARGET REMOTE_DIR TG_BOT_TOKEN TG_CHAT_ID GRAFANA_ADMIN_PASSWORD \
  || fail "020-grafana-contacts: required env vars unset (call from deploy.sh)"

if [ -z "${SSH_OPTS+x}" ]; then
  fail "020-grafana-contacts: SSH_OPTS array unset (call from deploy.sh)"
fi

# Wait briefly for Grafana to be answering inside the container — provisioning
# can take ~20-30s on a cold start. Bail with a clear message rather than
# halting the deploy if Grafana never comes up; the contact point is shipped
# by file provisioning regardless of whether this verification runs.
log "post-deploy/020: waiting for Grafana to be reachable"
ready=0
for i in $(seq 1 30); do
  if ssh_run "docker exec grafana wget --spider -q http://localhost:3000/api/health" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  warn "post-deploy/020: Grafana not reachable after 60s — contact point check skipped (file provisioning still applies)"
  exit 0
fi

# shellcheck source=../lib/bootstrap-grafana-contacts.sh
source "$OBS_LIB/bootstrap-grafana-contacts.sh"

log "post-deploy/020: verifying Grafana Telegram contact point"
bootstrap_grafana_contacts

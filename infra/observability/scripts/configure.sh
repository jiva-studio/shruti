#!/usr/bin/env bash
# infra/observability/scripts/configure.sh
#
# First-time / on-demand configuration of the observability stack:
#   1. Create wildcard Cloudflare DNS A record.
#   2. Wait for Langfuse, materialise secrets/langfuse-keys.env for the
#      chat service on prod-EU.
#   3. Re-apply the 90-day Langfuse ClickHouse TTL.
#   4. Re-verify the Grafana Telegram contact point.
#   5. Run the 10-point smoke verification.
#
# Re-runnable; each lib script is itself idempotent (skips on duplicates).
#
#   ./configure.sh --region eu [--obs-ip 100.x.x.B] [--ssh-user root]
#
# Reads config/<region>.env + config/shared.env. Writes secrets/langfuse-keys.env
# on the target host with the issued API keys.
#
# Relationship to deploy.sh post-deploy hooks:
#   The recurring pieces (Langfuse TTL re-apply, Grafana contact-point
#   re-verify) are also invoked by deploy.sh after every deploy via
#   infra/observability/scripts/post-deploy/*.sh — so operators no longer
#   need to remember to re-run configure.sh after a deploy just to keep
#   TTL drift at bay. This script is preserved for:
#     - First-time host setup (Cloudflare DNS bootstrap; not idempotent
#       across regions / not re-asserted on every deploy).
#     - Materialising secrets/langfuse-keys.env after the initial Langfuse
#       headless init lands.
#     - On-demand re-verification with the verify-stack smoke checks.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT="$ROOT/observability"
SHARED="$ROOT/shared"

# shellcheck source=../../shared/lib/deploy-common.sh
source "$SHARED/lib/deploy-common.sh"

REGION=eu
TARGET_IP=""
SSH_USER=root
SSH_KEY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --region)   REGION="$2"; shift 2 ;;
    --obs-ip)   TARGET_IP="$2"; shift 2 ;;
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    --ssh-key)  SSH_KEY="$2"; shift 2 ;;
    -h|--help)  sed -n '4,12p' "$0"; exit 0 ;;
    *)          fail "unknown arg: $1" ;;
  esac
done

[ -f "$UNIT/config/${REGION}.env" ] || fail "no config/${REGION}.env"
[ -f "$UNIT/config/shared.env" ]    || fail "no config/shared.env"

set -a
# shellcheck source=/dev/null
source "$UNIT/config/${REGION}.env"
# shellcheck source=/dev/null
source "$UNIT/config/shared.env"
set +a

TARGET_IP="${TARGET_IP:-$OBS_TS_IP}"
[ "$TARGET_IP" != "100.0.0.0" ] || fail "OBS_TS_IP not set in config/${REGION}.env"

if [ -z "$SSH_KEY" ]; then
  SSH_KEY="$HOME/.ssh/id_ed25519"
fi
[ -f "$SSH_KEY" ] || fail "ssh key not found: $SSH_KEY"

SSH_TARGET="$SSH_USER@$TARGET_IP"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -i "$SSH_KEY")
REMOTE_DIR="/opt/shruti-observability"

export REGION TAILNET_DOMAIN OBS_TS_IP CF_API_TOKEN CF_ZONE_ID \
       TG_BOT_TOKEN TG_CHAT_ID \
       LANGFUSE_INIT_USER_EMAIL LANGFUSE_INIT_USER_PASSWORD \
       REMOTE_DIR
export SSH_TARGET_STR="$SSH_TARGET"
export SSH_KEY_PATH="$SSH_KEY"

# 1. Cloudflare DNS
# shellcheck source=lib/bootstrap-cloudflare-dns.sh
source "$UNIT/scripts/lib/bootstrap-cloudflare-dns.sh"
bootstrap_cloudflare_dns

# 2. Langfuse project + keys
# shellcheck source=lib/bootstrap-langfuse.sh
source "$UNIT/scripts/lib/bootstrap-langfuse.sh"
bootstrap_langfuse

# 2b. 90-day ClickHouse TTL on Langfuse tables (account-deletion safety net
#     + cost cap; see README → "Langfuse data retention").
# shellcheck source=lib/bootstrap-langfuse-ttl.sh
source "$UNIT/scripts/lib/bootstrap-langfuse-ttl.sh"
bootstrap_langfuse_ttl

# 3. Grafana Telegram contact point — provisioning already covers this,
#    but the lib also handles the case where the operator wants to update
#    the chat ID after the stack is already running.
# shellcheck source=lib/bootstrap-grafana-contacts.sh
source "$UNIT/scripts/lib/bootstrap-grafana-contacts.sh"
bootstrap_grafana_contacts

# 4. Smoke verify
# shellcheck source=lib/verify-stack.sh
source "$UNIT/scripts/lib/verify-stack.sh"
verify_stack

report_urls "Configure done ($REGION)" \
  "https://grafana.${TAILNET_DOMAIN}" \
  "https://langfuse.${TAILNET_DOMAIN}" \
  "Langfuse API keys: $SSH_TARGET:$REMOTE_DIR/secrets/langfuse-keys.env"

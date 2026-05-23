#!/usr/bin/env bash
# infra/shared/lib/tailscale-bootstrap.sh
# Install Tailscale on the target host and bring the node up with the
# requested tag(s). Idempotent.
#
# Required env: TAILSCALE_AUTHKEY (reusable, pre-approved, tagged auth key)
# Required arg: --tag tag:<name>   (one or more, comma-separated)
#
# Usage from a deploy.sh:
#   source infra/shared/lib/deploy-common.sh
#   source infra/shared/lib/tailscale-bootstrap.sh
#   tailscale_bootstrap --tag tag:lectorium-obs
#
# Note: the auth key must be created with --reusable --tags=tag:lectorium-obs (or
# whatever you pass here). Without --reusable, second deploy fails silently.
# shellcheck shell=bash

tailscale_bootstrap() {
  local tags=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tag)  tags="${tags}${tags:+,}$2"; shift 2 ;;
      *) echo "tailscale_bootstrap: unknown arg $1" >&2; return 1 ;;
    esac
  done
  [ -n "$tags" ] || { echo "tailscale_bootstrap: --tag required" >&2; return 1; }
  [ -n "${TAILSCALE_AUTHKEY:-}" ] || {
    echo "tailscale_bootstrap: TAILSCALE_AUTHKEY env var required" >&2; return 1;
  }

  log "Installing Tailscale on $SSH_TARGET..."
  TS_AUTHKEY="$TAILSCALE_AUTHKEY" TS_TAGS="$tags" ssh_pipe <<'REMOTE'
set -euo pipefail
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# Bring up only if not already up
if tailscale status --json 2>/dev/null | jq -e '.BackendState == "Running"' >/dev/null; then
  echo "✓ tailscale already up — skipping 'tailscale up'"
else
  tailscale up \
    --authkey="${TS_AUTHKEY}" \
    --advertise-tags="${TS_TAGS}" \
    --ssh=false \
    --accept-routes=false
fi

ts_ip=$(tailscale ip -4 | head -1)
echo "✓ Tailscale up, ip=${ts_ip}, tags=${TS_TAGS}"
REMOTE
}

# Print the Tailscale IPv4 of the remote host (one line, no newline).
tailscale_remote_ip() {
  ssh_run 'tailscale ip -4 | head -1'
}

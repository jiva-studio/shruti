#!/usr/bin/env bash
# infra/shared/templates/ufw-rules.sh
# Standard firewall ruleset for any Shruti host that lives in the
# Tailscale overlay. Apply ONCE per host (idempotent — `ufw` dedupes).
#
# Policy:
#   - SSH (22/tcp)  — allowed from public internet (key-only auth)
#   - tailscale0    — allow ALL incoming on the overlay interface
#   - default deny  — everything else from the public NIC
#
# Exporters / Grafana / Loki / Langfuse bind explicitly to the Tailscale
# IP (e.g. `--web.listen-address=100.x.x.X:9100`), so ufw is belt + braces.
#
# Usage on the host:
#   sudo bash ufw-rules.sh
set -euo pipefail

if ! command -v ufw >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq ufw
fi

# Reset to a known baseline — safe, we re-add everything below.
ufw --force reset >/dev/null

ufw default deny incoming
ufw default allow outgoing

# Public surface: only SSH.
ufw allow OpenSSH

# Trust the Tailscale overlay completely.
ufw allow in on tailscale0

ufw --force enable
ufw status verbose

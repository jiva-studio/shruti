#!/usr/bin/env bash
# Placeholder post-deploy hook — demonstrates the convention.
#
# Delete this file and replace with a real idempotent infra-config script
# as soon as one is needed (e.g. ALTER TABLE … MODIFY TTL, Grafana contact
# bootstrap, Loki retention reconfigure, etc.).
#
# Contract: see infra/app/scripts/post-deploy/README.md
#   - idempotent
#   - self-skip when no-op
#   - exit 0 on success or no-op; non-zero halts the deploy
set -euo pipefail

echo "→ example: nothing to do, demo of the convention"

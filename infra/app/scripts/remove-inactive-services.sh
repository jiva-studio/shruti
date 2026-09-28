#!/usr/bin/env bash
# Stops and removes this Compose project's containers whose service the active
# file set and COMPOSE_PROFILES do not run. `up --remove-orphans` leaves a
# service that is still defined but profile-disabled running; this does not.
#
# Usage: COMPOSE_PROFILES=<role> remove-inactive-services.sh -f <file> [-f <file>...]
# Run from the directory the compose files are relative to.
set -euo pipefail

[ -n "${COMPOSE_PROFILES:-}" ] || {
  echo "✗ COMPOSE_PROFILES is not set; without it no service is active and every container would be removed" >&2
  exit 1
}
project=$(docker compose "$@" config | awk '/^name:/{print $2; exit}')
[ -n "$project" ] || { echo "✗ could not resolve the compose project name" >&2; exit 1; }
active=$(docker compose "$@" config --services)
[ -n "$active" ] || { echo "✗ no service is active for COMPOSE_PROFILES=$COMPOSE_PROFILES; removing nothing" >&2; exit 1; }

docker ps -a --filter "label=com.docker.compose.project=$project" \
  --format '{{.ID}} {{.Label "com.docker.compose.service"}}' |
  while read -r id service; do
    if ! grep -qxF "$service" <<<"$active"; then
      echo "  removing $service (not run by this role)"
      docker rm -f "$id" >/dev/null
    fi
  done

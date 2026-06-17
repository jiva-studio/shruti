#!/usr/bin/env bash
# One command to run the WHOLE suite (offline + live): brings the local backend
# stack up if it isn't already, then runs every test into one report.
#
#   ./scripts/run-all.sh            # offline + live (default)
#   ./scripts/run-all.sh --offline  # offline only (no stack needed)
#
# The live app is served from :8080 (a CORS-whitelisted origin — see README).
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAT_URL="http://localhost:${LECTORIUM_CHAT_PORT:-11080}"
MODE="${1:-all}"

ensure_stack() {
  if curl -fsS --max-time 4 "$CHAT_URL/readyz" 2>/dev/null | grep -q '"ready":true'; then
    echo ">> stack already up ($CHAT_URL/readyz green)"
    return 0
  fi
  # Find a lectorium checkout that has the stack config (.env.dev). Prefer a
  # sibling main checkout; fall back to this worktree's repo root.
  local repo=""
  for cand in "$E2E_DIR/../../../../lectorium" "$E2E_DIR/../../.."; do
    [[ -f "$cand/infra/app/.env.dev" ]] && { repo="$(cd "$cand" && pwd)"; break; }
  done
  if [[ -z "$repo" ]]; then
    echo "!! no infra/app/.env.dev found — run 'make stack-setup' in your lectorium checkout first" >&2
    exit 1
  fi
  echo ">> bringing up core stack from $repo"
  ( cd "$repo/infra/app/compose" \
    && LECTORIUM_TS_IP="${LECTORIUM_TS_IP:-127.0.0.1}" COMPOSE_PROFILES=origin \
       docker compose -p lectorium -f docker-compose.yml -f docker-compose.dev.yml \
         --env-file ../.env.dev up -d postgres redis migrator auth chat )
  echo ">> waiting for chat /readyz …"
  for _ in $(seq 1 60); do
    curl -fsS --max-time 4 "$CHAT_URL/readyz" 2>/dev/null | grep -q '"ready":true' && { echo ">> ready"; return 0; }
    sleep 3
  done
  echo "!! chat not ready after 180s — check OPENROUTER_API_KEY in .env.dev" >&2
  exit 1
}

cd "$E2E_DIR"
case "$MODE" in
  --offline|offline)
    npm run test:offline
    ;;
  *)
    ensure_stack
    npm run test:all
    ;;
esac

echo
echo ">> done. Open the report:  (cd $E2E_DIR && npm run report)"

#!/usr/bin/env bash
# One-shot: nuke the legacy /opt/lectorium-chat stack + its volumes.
#
# Used once per VPS to clear the previous deployment generation before
# the first deploy.sh of the new unified stack. Idempotent: re-running
# after a clean state is a no-op.
#
# Run ON THE VPS (not from the workstation). Best invocation:
#   ssh root@<ip> 'bash -s' < infra/scripts/wipe-old.sh
#
# Safety:
#   - Only touches volumes whose names start with explicit legacy
#     prefixes (lectorium-chat_*, chat_*, compose_*). The new stack uses
#     `name: lectorium` so all its volumes are prefixed `lectorium_*` —
#     this script intentionally never touches those.
#   - /opt/lectorium-chat removal is rm -rf; that directory is the
#     legacy code+config drop, never the new one. The new stack lives
#     in /opt/lectorium.
set -euo pipefail

OLD_DIR="/opt/lectorium-chat"

# Legacy volume prefixes — both the old "lectorium-chat" project and
# even older "compose"/"chat" project names. These are the ONLY volumes
# this script will consider. Anything else is left alone.
LEGACY_VOLUMES=(
  "lectorium-chat_pgdata"
  "lectorium-chat_chatdata"
  "lectorium-chat_caddydata"
  "lectorium-chat_caddyconfig"
  "chat_pgdata"
  "chat_chatdata"
  "chat_caddydata"
  "chat_caddyconfig"
  "compose_pgdata"
  "compose_chatdata"
  "compose_caddydata"
  "compose_caddyconfig"
)

# ── 1. Detect anything to do. ────────────────────────────────────────
have_dir=false
[ -d "$OLD_DIR" ] && have_dir=true

have_vol=false
for v in "${LEGACY_VOLUMES[@]}"; do
  if docker volume inspect "$v" >/dev/null 2>&1; then
    have_vol=true
    break
  fi
done

if ! $have_dir && ! $have_vol; then
  echo "✓ no legacy /opt/lectorium-chat or chat_*/compose_*/lectorium-chat_* volumes — nothing to do."
  exit 0
fi

# ── 2. Stop any compose stacks pointed at by old YAML files. ─────────
if $have_dir; then
  for compose in \
    "$OLD_DIR/services/chat/compose/docker-compose.yml" \
    "$OLD_DIR/compose/docker-compose.yml"; do
    if [ -f "$compose" ]; then
      echo "→ Stopping old compose: $compose"
      docker compose -f "$compose" down --remove-orphans -v 2>/dev/null || true
    fi
  done
fi

# ── 3. Remove the legacy volumes by exact name. ──────────────────────
for v in "${LEGACY_VOLUMES[@]}"; do
  if docker volume inspect "$v" >/dev/null 2>&1; then
    echo "→ docker volume rm $v"
    docker volume rm "$v" >/dev/null || echo "  (volume in use — try again after compose down)"
  fi
done

# ── 4. Remove the legacy directory. ──────────────────────────────────
if [ -d "$OLD_DIR" ]; then
  echo "→ rm -rf $OLD_DIR"
  rm -rf "$OLD_DIR"
fi

echo "✓ legacy state cleared. Run deploy.sh next."

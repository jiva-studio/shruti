#!/usr/bin/env bash
# Push the shruti stack onto a VPS. Code-only — secrets stay on the host.
#
# Pre-deploy (one-time per VPS, by hand):
#   1. mkdir -p /opt/shruti/jwt
#   2. scp /opt/shruti/.env (SHRUTI_POSTGRES_PASSWORD etc. — see
#      infra/.env.example for shape)
#   3. scp the JWT keypair to /opt/shruti/jwt/{private,public}.pem
#   4. chmod 600 on .env and jwt/private.pem
#   5. If migrating from /opt/shruti-chat: run infra/app/scripts/wipe-old.sh
#      from the VPS once to remove legacy compose + volumes.
#
# What this script does each run, idempotently:
#   - SSH bootstrap of docker + compose plugin (no-op if already there)
#   - rsync ONLY infra/ to /opt/shruti/ (no service source — images
#     come from ghcr.io)
#   - docker compose pull (fetches the :latest tag of each service image)
#   - docker compose up -d (starts migrator → services → caddy in order)
#   - wait for health-checks of chat + auth
#
# Required:   SERVER_IP=<ipv4>  ./infra/app/scripts/deploy.sh
# Optional:   SERVER_USER (root), SSH_KEY (~/.ssh/id_ed25519)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INFRA="$ROOT/infra"

SERVER_IP="${SERVER_IP:?SERVER_IP env var required}"
SERVER_USER="${SERVER_USER:-root}"

if [ -z "${SSH_KEY:-}" ]; then
  if [ -n "${WORKSPACE_CWD:-}" ] && [ -f "${WORKSPACE_CWD}/../.config/ssh/id_ed25519" ]; then
    SSH_KEY="${WORKSPACE_CWD}/../.config/ssh/id_ed25519"
  else
    SSH_KEY="$HOME/.ssh/id_ed25519"
  fi
fi
[ -f "$SSH_KEY" ] || { echo "✗ SSH key not found at $SSH_KEY"; exit 1; }

REMOTE_DIR="/opt/shruti"
SSH_OPTS=(-o "StrictHostKeyChecking=accept-new" -o "ServerAliveInterval=30" -i "$SSH_KEY")
SSH_TARGET="$SERVER_USER@$SERVER_IP"

ssh_run()  { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
ssh_pipe() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'bash -s'; }

# ── 1. SSH up; bootstrap docker. ─────────────────────────────────────
echo "→ Waiting for SSH on $SERVER_IP..."
for i in $(seq 1 60); do
  if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
    echo "✓ SSH up"
    break
  fi
  sleep 4
done

echo "→ Ensuring docker on host..."
ssh_pipe < "$INFRA/app/scripts/bootstrap.sh"

# ── 2. Confirm operator has placed secrets in /opt/shruti/. ───────
# This script never touches secrets. Operator scp's .env and JWT keys
# manually (one-time per host).
ssh_run "
  set -e
  err() { echo \"✗ \$1\" >&2; exit 1; }
  [ -f $REMOTE_DIR/.env ]              || err \"$REMOTE_DIR/.env missing — scp it from your local infra/.env\"
  [ -f $REMOTE_DIR/jwt/private.pem ]   || err \"$REMOTE_DIR/jwt/private.pem missing — scp the JWT keypair into $REMOTE_DIR/jwt/\"
  [ -f $REMOTE_DIR/jwt/public.pem ]    || err \"$REMOTE_DIR/jwt/public.pem missing — scp the JWT keypair into $REMOTE_DIR/jwt/\"
"

# ── 3. rsync infra/ (compose + migrations + Caddyfile + scripts). ────
# Only infra/ — service source no longer ships on the wire; ghcr serves
# the actual images. Migrations DO ship (mounted into the migrator
# container at /migrations).
echo "→ Syncing infra/ to $REMOTE_DIR/infra/..."
rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.env' --exclude '.env.*' \
  "$INFRA/" \
  "$SSH_TARGET:$REMOTE_DIR/infra/"

# ── 4. Pull latest images and bring stack up. ────────────────────────
# `docker compose pull` honours image tags from .env (e.g. if the
# operator pinned SHRUTI_AUTH_TAG=main-<sha> for a rollback, that's
# what gets pulled, not :latest).
#
# Override DOCKER_CONFIG so the daemon reads ghcr credentials from the
# project tree (/opt/shruti/config/config.json) rather than
# /root/.docker — keeps all per-project state under $REMOTE_DIR.
COMPOSE_CMD="DOCKER_CONFIG=$REMOTE_DIR/config docker compose -f infra/app/compose/docker-compose.yml -f infra/app/compose/docker-compose.prod.yml --env-file .env"

echo "→ docker compose pull..."
ssh_run "cd $REMOTE_DIR && $COMPOSE_CMD pull"

echo "→ docker compose up -d..."
ssh_run "cd $REMOTE_DIR && $COMPOSE_CMD up -d"

# ── 5. Health-check. ─────────────────────────────────────────────────
DOMAIN=$(ssh_run "grep -E '^SHRUTI_DOMAIN=' $REMOTE_DIR/.env | head -1 | cut -d= -f2-")
URL="https://$DOMAIN"
echo "→ Waiting for $URL/healthz (Caddy + LE may take ~60s on first run)..."
for i in $(seq 1 120); do
  if curl -fsS "$URL/healthz" >/dev/null 2>&1; then
    echo "✓ chat /healthz OK"
    break
  fi
  sleep 3
done

echo "→ Waiting for $URL/auth/healthz..."
for i in $(seq 1 60); do
  if curl -fsS "$URL/auth/healthz" >/dev/null 2>&1; then
    echo "✓ auth /auth/healthz OK"
    break
  fi
  sleep 2
done

echo
echo "✓ Deployed: $URL"
echo "  ssh $SERVER_USER@$SERVER_IP"
echo "  logs: ssh $SERVER_USER@$SERVER_IP 'cd $REMOTE_DIR && docker compose -f infra/app/compose/docker-compose.yml -f infra/app/compose/docker-compose.prod.yml logs -f'"

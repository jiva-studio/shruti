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
#   - rsync only infra/ to /opt/shruti/ (no service source — images
#     come from ghcr.io; Caddyfile and SQL migrations are baked into
#     their images, not shipped via rsync)
#   - docker compose pull (fetches the :latest tag of each service image)
#   - docker compose up -d (starts migrator → services → caddy in order)
#   - wait for health-checks of chat + auth
#
# When to run:
#   - First-time setup of a VPS.
#   - Changes to docker-compose.yml / docker-compose.prod.yml structure.
#   - After a migration is published: migrator is a one-shot container,
#     so Watchtower can't auto-restart it; re-run this script (or
#     `docker compose up -d migrator` on the host) to apply.
#
# When not needed:
#   - Caddyfile edits — baked into the shruti-caddy image, Watchtower
#     rolls the container after CI publishes.
#   - Service code edits — baked into per-service images, Watchtower
#     rolls them after CI publishes.
#
# Required:   SERVER_IP=<ipv4>  ./infra/app/scripts/deploy.sh
# Optional:   SERVER_USER (root), SSH_KEY (~/.ssh/id_ed25519)
#             --role origin|proxy|edge (default: origin)
#             --force-role-switch (edge only: allow a host that runs
#             services other than a proxy's to become an edge)
#
# --role selects the deployment shape:
#   origin  — full backend (postgres+pgvector, redis, migrator, auth, chat,
#             cleanup-worker, share-audio, share-video, caddy, watchtower).
#             Combines docker-compose.yml + docker-compose.prod.yml.
#   proxy   — thin RU box (slim postgres, redis, migrator, share-audio,
#             share-video, caddy reverse-proxying chat+auth upstream).
#             Combines docker-compose.yml + docker-compose.prod.yml +
#             docker-compose.proxy.yml; activates COMPOSE_PROFILES=proxy.
#   edge    — stateless regional entry point: caddy alone, /public/* to the
#             CDN and everything else to origin. Combines
#             docker-compose.prod.yml + docker-compose.edge.yml (not the base
#             file); activates COMPOSE_PROFILES=edge. Needs no JWT keys and no
#             database password.
#
# The role can also be set per-host by writing SHRUTI_REGION_ROLE=…
# into /opt/shruti/.env (the script reads it back if --role is omitted).
# Proxy and edge hosts must also have SHRUTI_GLOBAL_HOST=<global-domain>
# set in .env so Caddy knows where to forward; edge hosts also need
# SHRUTI_EDGE_CDN_UPSTREAM and SHRUTI_EDGE_CDN_PROBE_PATH.
#
# Host-specific values (S3 creds, OAuth client IDs, DB password) live
# entirely in /opt/shruti/.env on the host. The compose files are
# host-agnostic; only role selection differs.
set -euo pipefail

# ── Arg parse: --role origin|proxy ──────────────────────────────────
ROLE=""
FORCE_ROLE_SWITCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force-role-switch)
      FORCE_ROLE_SWITCH=1
      shift
      ;;
    --role)
      ROLE="${2:-}"
      shift 2
      ;;
    --role=*)
      ROLE="${1#--role=}"
      shift
      ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "✗ unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INFRA="$ROOT/infra"
# shellcheck source=lib/edge-checks.sh
source "$INFRA/app/scripts/lib/edge-checks.sh"

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

# ── 2. Confirm operator has placed .env in /opt/shruti/. ──────────
# This script never touches secrets. Operator scp's .env and JWT keys
# manually (one-time per host). The JWT key check is deferred until
# after role resolution (step 3.6) because proxy hosts skip private.pem.
ssh_run "
  set -e
  [ -f $REMOTE_DIR/.env ] || { echo \"✗ $REMOTE_DIR/.env missing — scp it from your local infra/.env\" >&2; exit 1; }
"

# ── 3. rsync infra/ (compose + migrations + Caddyfile + scripts). ────
# Only infra/ — service source does not ship on the wire; ghcr serves
# the actual images. Migrations do ship (mounted into the migrator
# container at /migrations).
echo "→ Syncing infra/ to $REMOTE_DIR/infra/..."
rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.env' --exclude '.env.*' \
  "$INFRA/" \
  "$SSH_TARGET:$REMOTE_DIR/infra/"

# ── 3.5. Mirror cross-region JWT pubkeys into /opt/shruti/jwt/. ───
# Every region trusts every other region's pubkey, distributed via
# the repo's infra/app/jwt-keys/ folder (see that dir's README). The
# auth + chat + share-video verifiers (NewVerifierFromDir) scan
# /secrets — which mounts /opt/shruti/jwt — so any `*.pub.pem` we
# drop here is picked up on next container start.
#
# Restart the three verifier-loading services so a freshly-added
# region pubkey is trusted immediately, not on the next deploy that
# happens to touch their image tags.
echo "→ Installing JWT pubkeys from infra/app/jwt-keys/..."
ssh_run "
  set -e
  if [ -d $REMOTE_DIR/infra/app/jwt-keys ]; then
    install -d -m 0755 -o root -g root $REMOTE_DIR/jwt
    for pem in $REMOTE_DIR/infra/app/jwt-keys/*.pub.pem; do
      [ -e \"\$pem\" ] || continue
      install -m 0644 -o root -g root \"\$pem\" $REMOTE_DIR/jwt/
    done
    echo \"  installed: \$(ls $REMOTE_DIR/jwt/*.pub.pem 2>/dev/null | xargs -n1 basename | tr '\n' ' ')\"
  else
    echo \"  (no jwt-keys/ in deploy bundle — skipped)\"
  fi
"

# ── 3.6. Resolve role. CLI flag wins; otherwise read from host .env. ─
# Role drives which compose overlays we layer and which COMPOSE_PROFILES
# is active. Default origin keeps existing single-host installs unchanged.
if [ -z "$ROLE" ]; then
  ROLE=$(ssh_run "grep -E '^SHRUTI_REGION_ROLE=' $REMOTE_DIR/.env | tail -1 | cut -d= -f2- | tr -d '\r\"'" || true)
  ROLE="${ROLE:-origin}"
fi
case "$ROLE" in
  origin|proxy|edge) ;;
  *) echo "✗ --role must be origin, proxy or edge (got: $ROLE)" >&2; exit 2 ;;
esac
echo "→ Deploying with role: $ROLE"

# ── 3.7. Required files and settings (role-conditional). ────────────
# Proxy hosts never sign tokens (auth lives on origin), so private.pem
# is not required there — only public.pem is needed for share-audio +
# share-video JWT verification. Origin hosts run auth and need both.
# Edge hosts verify nothing and store nothing: no keys, no database
# password, only the two upstreams and the CDN probe object.
if [ "$ROLE" = "edge" ]; then
  compose_v=$(ssh_run "docker compose version --short" 2>/dev/null || true)
  if ! compose_version_ok "$compose_v"; then
    echo "✗ Docker Compose ${compose_v:-(unknown)} on the host; the edge overlay needs $EDGE_MIN_COMPOSE_VERSION or later (older versions ignore its !override / !reset tags)" >&2
    exit 1
  fi
  # An edge deploy removes every container the edge does not run. From a proxy
  # host that is intended; from anything else (origin: auth, chat, databases)
  # it is almost certainly the wrong host, so it needs --force-role-switch.
  running=$(ssh_run "docker ps --filter label=com.docker.compose.project=shruti --format '{{.Label \"com.docker.compose.service\"}}' | sort -u")
  # shellcheck disable=SC2086
  blockers=$(edge_switch_blockers $running | tr '\n' ' ')
  if [ -n "$blockers" ] && [ "$FORCE_ROLE_SWITCH" != 1 ]; then
    echo "✗ $SERVER_IP runs ${blockers}— services an edge host does not run. Deploying edge would remove them (volumes stay). Re-run with --force-role-switch if this host really is becoming an edge." >&2
    exit 1
  fi
  ssh_run "
    set -e
    for v in SHRUTI_DOMAIN SHRUTI_ACME_EMAIL SHRUTI_GLOBAL_HOST SHRUTI_EDGE_CDN_UPSTREAM SHRUTI_EDGE_CDN_PROBE_PATH; do
      grep -qE \"^\$v=.+\" $REMOTE_DIR/.env || { echo \"✗ \$v missing from $REMOTE_DIR/.env (see infra/app/.env.example)\" >&2; exit 1; }
    done
  "
else
  ssh_run "
    set -e
    [ -f $REMOTE_DIR/jwt/public.pem ] || { echo \"✗ $REMOTE_DIR/jwt/public.pem missing — scp the JWT keypair into $REMOTE_DIR/jwt/\" >&2; exit 1; }
    if [ \"$ROLE\" != \"proxy\" ]; then
      [ -f $REMOTE_DIR/jwt/private.pem ] || { echo \"✗ $REMOTE_DIR/jwt/private.pem missing — scp the JWT keypair into $REMOTE_DIR/jwt/\" >&2; exit 1; }
    fi
  "
fi

# ── 4. Pull latest images and bring stack up. ────────────────────────
# `docker compose pull` honours image tags from .env (e.g. if the
# operator pinned SHRUTI_AUTH_TAG=main-<sha> for a rollback, that's
# what gets pulled, not :latest).
#
# Override DOCKER_CONFIG so the daemon reads ghcr credentials from the
# project tree (/opt/shruti/config/config.json) rather than
# /root/.docker — keeps all per-project state under $REMOTE_DIR.
#
# Role selects overlay set + active profile. proxy adds docker-compose.proxy.yml
# (postgres → alpine, caddy SHRUTI_REGION_ROLE=proxy) and activates
# COMPOSE_PROFILES=proxy so auth/chat/cleanup-worker are profile-excluded.
# edge layers docker-compose.edge.yml on the prod overlay alone: the base file
# would demand a database password the edge has no use for.
if [ "$ROLE" = "proxy" ]; then
  COMPOSE_FILES="-f infra/app/compose/docker-compose.yml -f infra/app/compose/docker-compose.prod.yml -f infra/app/compose/docker-compose.proxy.yml"
  PROFILES="proxy"
elif [ "$ROLE" = "edge" ]; then
  COMPOSE_FILES="-f infra/app/compose/docker-compose.prod.yml -f infra/app/compose/docker-compose.edge.yml"
  PROFILES="edge"
else
  COMPOSE_FILES="-f infra/app/compose/docker-compose.yml -f infra/app/compose/docker-compose.prod.yml"
  PROFILES="origin"
fi
COMPOSE_CMD="DOCKER_CONFIG=$REMOTE_DIR/config COMPOSE_PROFILES=$PROFILES docker compose $COMPOSE_FILES --env-file .env"

echo "→ docker compose pull..."
ssh_run "cd $REMOTE_DIR && $COMPOSE_CMD pull"

echo "→ docker compose up -d..."
# --remove-orphans reaps containers from services no longer in the
# active compose set. Critical when a host is repurposed (origin → proxy
# or vice versa) so the old auth/chat/cleanup-worker containers don't
# linger after the role flip.
ssh_run "cd $REMOTE_DIR && $COMPOSE_CMD up -d --remove-orphans"

# A profile-disabled service is still defined, so --remove-orphans keeps it:
# a proxy host switched to edge would keep its watchtower and
# docker-socket-proxy. Remove whatever the edge set does not run.
if [ "$ROLE" = "edge" ]; then
  echo "→ Removing services the edge role does not run..."
  ssh_run "cd $REMOTE_DIR && DOCKER_CONFIG=$REMOTE_DIR/config COMPOSE_PROFILES=$PROFILES bash infra/app/scripts/remove-inactive-services.sh $COMPOSE_FILES --env-file .env"
fi

# Restart the verifier-loading services so they pick up any newly
# added *.pub.pem from step 3.5. `up -d` only restarts containers
# whose image / config diffs; a fresh pub.pem in the mounted dir
# does not trigger a restart on its own.
# On proxy: only share-video is present (auth + chat live on origin).
# On edge: nothing verifies a token.
if [ "$ROLE" = "proxy" ]; then
  RESTART_SVCS="share-video"
elif [ "$ROLE" = "edge" ]; then
  RESTART_SVCS=""
else
  RESTART_SVCS="auth chat share-video"
fi
if [ -n "$RESTART_SVCS" ]; then
  echo "→ Restarting $RESTART_SVCS to reload JWT pubkeys..."
  ssh_run "cd $REMOTE_DIR && $COMPOSE_CMD restart $RESTART_SVCS" || true
fi

# ── 5. Health-check. ─────────────────────────────────────────────────
# On origin we probe chat + auth (terminate locally). On proxy those
# paths reverse-proxy to SHRUTI_GLOBAL_HOST, so a green probe here
# would actually be measuring the global host's health, not this one.
# Probe the share-* services instead — those are the only HTTP services
# that genuinely run locally on the proxy box.
DOMAIN=$(ssh_run "grep -E '^SHRUTI_DOMAIN=' $REMOTE_DIR/.env | head -1 | cut -d= -f2-")
URL="https://$DOMAIN"
if [ "$ROLE" = "edge" ]; then
  # /healthz is the edge itself, /healthz/api is origin through the edge,
  # /healthz/cdn is the CDN probe object through the edge. The probe object
  # is read whole under a deadline and must exceed 64 KB, so a path that
  # stalls after the first few KB fails here too. Any red check fails the
  # deploy: an edge with a dead upstream serves nothing.
  echo "→ Waiting for $URL/healthz (Caddy + LE may take ~60s on first run)..."
  edge_ok=0
  for _ in $(seq 1 120); do
    if [ "$(curl -fsS --max-time 5 "$URL/healthz" 2>/dev/null)" = "ok edge" ]; then
      echo "✓ edge /healthz OK"
      edge_ok=1
      break
    fi
    sleep 3
  done
  [ "$edge_ok" = 1 ] || { echo "✗ $URL/healthz never answered \"ok edge\"" >&2; exit 1; }

  if curl -fsS --max-time 15 -o /dev/null "$URL/healthz/api"; then
    echo "✓ origin through the edge: /healthz/api OK"
  else
    echo "✗ $URL/healthz/api failed — the edge cannot reach origin" >&2; exit 1
  fi

  if cdn_seen=$(edge_cdn_probe_ok "$URL/healthz/cdn" 30); then
    echo "✓ CDN through the edge: /healthz/cdn delivered $cdn_seen"
  else
    echo "✗ $URL/healthz/cdn: $cdn_seen — check SHRUTI_EDGE_CDN_UPSTREAM / SHRUTI_EDGE_CDN_PROBE_PATH" >&2
    exit 1
  fi
elif [ "$ROLE" = "proxy" ]; then
  echo "→ Waiting for $URL/share/audio/healthz (Caddy + LE may take ~60s on first run)..."
  for i in $(seq 1 120); do
    if curl -fsS "$URL/share/audio/healthz" >/dev/null 2>&1; then
      echo "✓ share-audio /healthz OK"
      break
    fi
    sleep 3
  done

  echo "→ Waiting for $URL/share/video/healthz..."
  for i in $(seq 1 60); do
    if curl -fsS "$URL/share/video/healthz" >/dev/null 2>&1; then
      echo "✓ share-video /healthz OK"
      break
    fi
    sleep 2
  done
else
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
fi

# ── 6. Post-deploy hooks. Each is idempotent; failure halts the deploy. ──
# See infra/app/scripts/post-deploy/README.md for the contract.
# Skipped on proxy and edge: the hooks target origin-only surfaces
# (postgres-exporter grants on auth/app schemas that ship empty on proxy
# and do not exist on edge). Per-hook role guards live in the hook itself
# when needed.
if [ "$ROLE" != "origin" ]; then
  echo "→ Skipping post-deploy hooks (role=$ROLE)"
else
  echo "→ Running post-deploy hooks..."
  HOOKS=$(ssh_run "ls $REMOTE_DIR/infra/app/scripts/post-deploy/[0-9]*.sh 2>/dev/null || true")
  if [ -z "$HOOKS" ]; then
    echo "  (none)"
  else
    ssh_run "
      set -e
      for s in $REMOTE_DIR/infra/app/scripts/post-deploy/[0-9]*.sh; do
        [ -f \"\$s\" ] || continue
        echo \"  • \$(basename \$s)\"
        bash \"\$s\"
      done
    "
  fi
  echo "✓ Post-deploy hooks done"
fi

echo
echo "✓ Deployed: $URL"
echo "  ssh $SERVER_USER@$SERVER_IP"
echo "  logs: ssh $SERVER_USER@$SERVER_IP 'cd $REMOTE_DIR && docker compose -f infra/app/compose/docker-compose.yml -f infra/app/compose/docker-compose.prod.yml logs -f'"

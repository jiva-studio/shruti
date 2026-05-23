#!/usr/bin/env bash
# infra/shared/lib/deploy-common.sh
# Shared deploy helpers sourced by every infra/<unit>/scripts/deploy.sh.
#
# All functions assume the caller has set:
#   SSH_TARGET   - user@host
#   SSH_OPTS     - bash array of -o options
#   REMOTE_DIR   - absolute path on target host (e.g. /opt/lectorium-observability)
#
# Functions are pure bash, idempotent, and never destructive of existing secrets.
# shellcheck shell=bash

# ──────────────────────────────────────────────────────────────────────
# ssh helpers (require SSH_TARGET + SSH_OPTS set by caller)
# ──────────────────────────────────────────────────────────────────────
ssh_run()  { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
ssh_pipe() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'bash -s'; }

log()  { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ──────────────────────────────────────────────────────────────────────
# ensure_target_host_ready
# ──────────────────────────────────────────────────────────────────────
# Installs docker, docker-compose-plugin, chrony, ufw, jq, rsync, curl on
# a fresh Ubuntu host. Configures NTP. Applies docker daemon log rotation
# from infra/shared/templates/docker-daemon.json. Idempotent.
#
# Usage: ensure_target_host_ready
ensure_target_host_ready() {
  local shared_dir
  shared_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

  log "Waiting for SSH on $SSH_TARGET..."
  local i
  for i in $(seq 1 60); do
    if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'echo ok' >/dev/null 2>&1; then
      ok "SSH up"
      break
    fi
    sleep 4
  done

  log "Installing baseline packages (docker, chrony, ufw, jq, rsync)..."
  ssh_pipe <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg rsync jq chrony ufw

  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
  fi

  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
else
  # Make sure auxiliary tools are still present on older bootstraps.
  apt-get install -y -qq chrony ufw jq rsync curl >/dev/null 2>&1 || true
fi

timedatectl set-ntp true || true
systemctl enable --now chrony >/dev/null 2>&1 || true
REMOTE
  ok "Host packages ready"

  # Apply docker log rotation from shared template
  log "Applying docker daemon log rotation..."
  scp "${SSH_OPTS[@]}" "$shared_dir/templates/docker-daemon.json" \
    "$SSH_TARGET:/tmp/docker-daemon.json" >/dev/null
  ssh_pipe <<'REMOTE'
set -euo pipefail
mkdir -p /etc/docker
if ! cmp -s /tmp/docker-daemon.json /etc/docker/daemon.json 2>/dev/null; then
  cp /tmp/docker-daemon.json /etc/docker/daemon.json
  systemctl reload docker || systemctl restart docker
  echo "✓ docker daemon log rotation applied (restart triggered)"
else
  echo "✓ docker daemon log rotation already current"
fi
rm -f /tmp/docker-daemon.json
REMOTE
}

# ──────────────────────────────────────────────────────────────────────
# rsync_to_target <local_dir> <remote_dir> [extra rsync args...]
# ──────────────────────────────────────────────────────────────────────
rsync_to_target() {
  local src="$1" dst="$2"
  shift 2
  log "rsync $src → $SSH_TARGET:$dst"
  ssh_run "mkdir -p '$dst'"
  rsync -az --delete \
    -e "ssh ${SSH_OPTS[*]}" \
    --exclude='.git' --exclude='secrets/' --exclude='*.local.env' \
    --exclude='config/*.env' --exclude='config/*.env.example' \
    "$@" \
    "$src/" "$SSH_TARGET:$dst/"
  ok "rsync done"
}

# ──────────────────────────────────────────────────────────────────────
# ensure_secrets <remote_secrets_dir> <key1>:<gen_cmd> [key2:gen_cmd ...]
# ──────────────────────────────────────────────────────────────────────
# Idempotently generates secrets on the target host. Skips any key whose
# file already exists — never overwrites (overwriting ENCRYPTION_KEY would
# nuke Langfuse at-rest data).
#
# Example:
#   ensure_secrets /opt/lectorium-observability/secrets \
#     encryption_key:'openssl rand -hex 32' \
#     nextauth_secret:'openssl rand -base64 32'
ensure_secrets() {
  local secrets_dir="$1"; shift
  local spec key gen
  log "Ensuring secrets in $SSH_TARGET:$secrets_dir"
  ssh_run "mkdir -p '$secrets_dir' && chmod 700 '$secrets_dir'"
  for spec in "$@"; do
    key="${spec%%:*}"
    gen="${spec#*:}"
    ssh_pipe <<REMOTE
set -euo pipefail
f="$secrets_dir/$key"
if [ -s "\$f" ]; then
  echo "  · $key: existing — left untouched"
else
  ( $gen ) > "\$f"
  chmod 600 "\$f"
  echo "  · $key: generated"
fi
REMOTE
  done
  ok "secrets ready"
}

# ──────────────────────────────────────────────────────────────────────
# compose_up <remote_dir> [extra docker compose args...]
# ──────────────────────────────────────────────────────────────────────
compose_up() {
  local remote_dir="$1"; shift
  log "docker compose up -d in $remote_dir"
  # Private GHCR packages — docker reads auth from $remote_dir/config/config.json
  # (operator seeds it once: see infra/observability/README.md → "GHCR pull credentials").
  ssh_run "cd '$remote_dir/compose' && DOCKER_CONFIG='$remote_dir/config' docker compose pull --quiet && DOCKER_CONFIG='$remote_dir/config' docker compose up -d $*"
  ok "compose up complete"
}

# ──────────────────────────────────────────────────────────────────────
# wait_healthcheck <url> [max_seconds=180] [label="endpoint"]
# ──────────────────────────────────────────────────────────────────────
# Polls $url from the target host (curl --max-time 5) until 2xx or timeout.
wait_healthcheck() {
  local url="$1" max="${2:-180}" label="${3:-$url}"
  log "Waiting for $label (≤ ${max}s) → $url"
  ssh_pipe <<REMOTE
set -euo pipefail
start=\$(date +%s)
while :; do
  if curl -fs --max-time 5 "$url" >/dev/null 2>&1; then
    echo "✓ $label healthy"
    exit 0
  fi
  now=\$(date +%s)
  if [ \$(( now - start )) -ge $max ]; then
    echo "✗ $label not healthy after ${max}s" >&2
    exit 1
  fi
  sleep 3
done
REMOTE
}

# ──────────────────────────────────────────────────────────────────────
# report_urls <label> <url1> [url2 ...]
# ──────────────────────────────────────────────────────────────────────
report_urls() {
  local label="$1"; shift
  printf '\n%s\n' "$label"
  printf '─%.0s' $(seq 1 ${#label}); printf '\n'
  local u
  for u in "$@"; do
    printf '  %s\n' "$u"
  done
  printf '\n'
}

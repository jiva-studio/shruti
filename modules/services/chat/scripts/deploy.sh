#!/usr/bin/env bash
# Deploy Lectorium chat to a Hetzner VPS.
#
# Inputs (env or args):
#   SERVER_IP            (required)  Public IPv4 of the target VPS.
#   SERVER_USER          (default: root)
#   SSH_KEY              (default: $HOME/.ssh/id_ed25519)
#   DOMAIN               (default: <ip-dashed>.sslip.io)
#   ACME_EMAIL           (default: advaita.krishna.das@gmail.com)
#
# Usage:
#   SERVER_IP=159.69.12.34 ./scripts/deploy.sh
#   SERVER_IP=$(terraform -chdir=infra/terraform output -raw ipv4) ./scripts/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVER_IP="${SERVER_IP:?SERVER_IP env var required (e.g. 159.69.12.34)}"
SERVER_USER="${SERVER_USER:-root}"

# Pick SSH key:
#   1. $SSH_KEY env override   (CI/CD path: secret → file → env)
#   2. ${WORKSPACE_CWD}/../.config/ssh/id_ed25519  (direnv-set group key)
#   3. ~/.ssh/id_ed25519        (developer default)
if [ -z "${SSH_KEY:-}" ]; then
  if [ -n "${WORKSPACE_CWD:-}" ] && [ -f "${WORKSPACE_CWD}/../.config/ssh/id_ed25519" ]; then
    SSH_KEY="${WORKSPACE_CWD}/../.config/ssh/id_ed25519"
  else
    SSH_KEY="$HOME/.ssh/id_ed25519"
  fi
fi
[ -f "$SSH_KEY" ] || { echo "✗ SSH key not found at $SSH_KEY"; exit 1; }
DOMAIN="${DOMAIN:-$(echo "$SERVER_IP" | tr '.' '-').sslip.io}"
ACME_EMAIL="${ACME_EMAIL:-advaita.krishna.das@gmail.com}"

REMOTE_DIR="/opt/lectorium-chat"
SSH_OPTS=(-o "StrictHostKeyChecking=accept-new" -o "ServerAliveInterval=30" -i "$SSH_KEY")

# ── 1. Make sure local .env is ready and has prod-grade values. ─────
if [ ! -f .env ]; then
  echo "✗ .env missing; copy .env.example and fill keys before deploy"
  exit 1
fi

# Inject DOMAIN/ACME_EMAIL/POSTGRES_PASSWORD into the .env we ship (without
# touching the local one). POSTGRES_PASSWORD is generated once per server
# and kept in a side file on the VPS.
TMP_ENV=$(mktemp)
trap 'rm -f "$TMP_ENV"' EXIT
grep -v -E '^(DOMAIN|ACME_EMAIL|POSTGRES_PASSWORD|DATABASE_URL)=' .env > "$TMP_ENV"
echo "DOMAIN=$DOMAIN" >> "$TMP_ENV"
echo "ACME_EMAIL=$ACME_EMAIL" >> "$TMP_ENV"

# ── 2. Wait for SSH; cloud-init may still be running on first boot. ─
echo "→ Waiting for SSH on $SERVER_IP..."
for i in $(seq 1 60); do
  if ssh "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_IP" 'echo ok' >/dev/null 2>&1; then
    echo "✓ SSH up"
    break
  fi
  sleep 4
done

# ── 3. Install docker on first run (Cloud Provider Ubuntu doesn't have it). ─
echo "→ Ensuring docker is installed on the server..."
ssh "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_IP" 'bash -s' <<'REMOTE_BOOTSTRAP'
set -euo pipefail
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "  docker + compose plugin already present"
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync jq
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
mkdir -p /opt/lectorium-chat /var/lib/chat
echo "  installed: $(docker --version), $(docker compose version | head -1)"
REMOTE_BOOTSTRAP
echo "✓ docker ready"

# ── 4. POSTGRES_PASSWORD: generate once, persist on server. ─────────
PG_PASS=$(ssh "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_IP" \
  "if [ ! -f $REMOTE_DIR/.pg_password ]; then mkdir -p $REMOTE_DIR && head -c 24 /dev/urandom | base64 | tr -d '/+=' > $REMOTE_DIR/.pg_password; fi; cat $REMOTE_DIR/.pg_password")
echo "POSTGRES_PASSWORD=$PG_PASS" >> "$TMP_ENV"

# ── 5. Sync code + compose + Dockerfile. ────────────────────────────
echo "→ Syncing code to $SERVER_USER@$SERVER_IP:$REMOTE_DIR"
rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  --exclude '.venv' \
  --exclude '.povtorenie-work' \
  --exclude '*.tsv' \
  app compose scripts Dockerfile .dockerignore README.md \
  "$SERVER_USER@$SERVER_IP:$REMOTE_DIR/"

# Push the generated .env separately to a tmpfile then move atomically.
scp "${SSH_OPTS[@]}" "$TMP_ENV" "$SERVER_USER@$SERVER_IP:$REMOTE_DIR/.env.new"
ssh "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_IP" "mv $REMOTE_DIR/.env.new $REMOTE_DIR/.env"

# ── 6. Build + start. ───────────────────────────────────────────────
echo "→ docker compose up -d --build"
ssh "${SSH_OPTS[@]}" "$SERVER_USER@$SERVER_IP" \
  "cd $REMOTE_DIR && docker compose --env-file .env -f compose/docker-compose.yml up -d --build"

# ── 7. Wait for /healthz over HTTPS (Caddy needs cert first). ───────
URL="https://$DOMAIN"
echo "→ Waiting for $URL/healthz (Caddy + LE cert can take ~60s on first run)..."
for i in $(seq 1 120); do
  if curl -fsS "$URL/healthz" >/dev/null 2>&1; then
    echo "✓ healthz OK"
    break
  fi
  sleep 3
done

# ── 8. Final probes. ────────────────────────────────────────────────
echo "→ /readyz:"
curl -fsS "$URL/readyz" 2>&1 || true; echo

APP_TOKEN=$(grep -E '^APP_SHARED_TOKEN=' .env | cut -d= -f2- || true)
if [ -n "$APP_TOKEN" ]; then
  echo "→ /status:"
  curl -fsS -H "X-App-Token: $APP_TOKEN" "$URL/status" | jq . 2>/dev/null || echo "(no jq, raw:)" && \
    curl -fsS -H "X-App-Token: $APP_TOKEN" "$URL/status"
  echo
fi

echo
echo "✓ Deployed: $URL"
echo "  ssh root@$SERVER_IP"
echo "  fly-style logs: ssh root@$SERVER_IP 'cd $REMOTE_DIR && docker compose -f compose/docker-compose.yml logs -f chat'"

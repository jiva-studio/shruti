#!/usr/bin/env bash
# Bring up the local backend stack for @live E2E and check it's ready.
#
# What it does:
#   1. First-run setup if needed (`make stack-setup` → infra/app/.env.dev + JWT keys + npm i)
#   2. `make stack-up` (postgres + redis + chat + auth, built from source)
#   3. Waits for chat `/readyz`
#
# Requirements (filled into infra/app/.env.dev by you / stack-setup):
#   - OPENROUTER_API_KEY  — chat needs it to answer; without it `/readyz` stays false
#   - AWS_*               — corpus indexing
#   - LECTORIUM_TS_IP     — only the search-mcp service needs it; export a dummy if unused
#
# Seeding: for grounded chat answers the corpus must be indexed. Use a SMALL
# curated seed (a handful of library docs) via the chat service's index/import
# path — see modules/services/chat. An empty corpus still streams an (ungrounded)
# answer, which is enough for the send/receive smoke test.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"   # …/lectorium
export LECTORIUM_TS_IP="${LECTORIUM_TS_IP:-127.0.0.1}"

cd "$REPO_ROOT"
if [[ ! -f infra/app/.env.dev ]]; then
  echo ">> first-run: make stack-setup"
  make stack-setup
fi

# Pull secrets (OPENROUTER_API_KEY, optional AWS_*) from a local gitignored file
# so we don't hit 1Password every run. Create it once (see README):
#   op read "op://<vault>/<item>/<field>" → tests/e2e/mobile/.env.local
SECRETS="$REPO_ROOT/tests/e2e/mobile/.env.local"
if [[ -f "$SECRETS" ]]; then
  echo ">> injecting secrets from $SECRETS into .env.dev"
  # shellcheck disable=SC1090
  set -a; source "$SECRETS"; set +a
  for k in OPENROUTER_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION; do
    v="${!k:-}"
    [[ -z "$v" ]] && continue
    if grep -q "^${k}=" infra/app/.env.dev; then
      sed -i "s|^${k}=.*|${k}=${v}|" infra/app/.env.dev
    else
      echo "${k}=${v}" >> infra/app/.env.dev
    fi
  done
else
  echo "!! no $SECRETS — chat won't answer without OPENROUTER_API_KEY (see README)" >&2
fi

echo ">> make stack-up"
make stack-up

echo ">> waiting for chat /readyz …"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${LECTORIUM_CHAT_PORT:-11080}/readyz" >/dev/null 2>&1; then
    echo ">> chat ready"
    exit 0
  fi
  sleep 2
done
echo "!! chat /readyz not green after 120s — check OPENROUTER_API_KEY / AWS_* in infra/app/.env.dev" >&2
echo "   (the stack is up; chat just can't answer until keys are set)" >&2
exit 1

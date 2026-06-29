#!/usr/bin/env bash
# Generate an RSA-2048 JWT signing keypair.
#
# Two modes:
#
# 1. Prod mode:
#      gen-jwt-keys.sh --prod
#    Run on the origin VPS. Writes
#      /opt/lectorium/jwt/private.pem  (mode 0400, owner root)
#      /opt/lectorium/jwt/public.pem   (mode 0644, owner root)
#    The priv key NEVER leaves that box. Copy public.pem into the
#    repo at infra/app/jwt-keys/v1.pub.pem so share-audio / share-video
#    on every host can verify tokens.
#
# 2. Dev-bootstrap mode (no argument):
#    Materialises the workspace-wide single keypair from
#    $HOME/Projects/akdasa/dotfiles/.../credentials as symlinks at
#    .config/lectorium/jwt/{private,public}.pem so dev compose can
#    read them. Without persistent storage, regenerating keys would
#    invalidate every issued refresh token (90-day TTL); the dotfiles
#    repo is the source of truth so a fresh clone of the workspace
#    inherits valid keys.
#
# Idempotent in both modes — refuses to overwrite existing prod files,
# skips generation when the workspace symlinks already point at valid
# dotfiles keys.
set -euo pipefail

# ---------------------------------------------------------------- mode 1
if [ "${1:-}" = "--prod" ]; then
  dest="/opt/lectorium/jwt"
  priv="$dest/private.pem"
  pub="$dest/public.pem"

  sudo mkdir -p "$dest"

  if [ -e "$priv" ] || [ -e "$pub" ]; then
    echo "Refusing to overwrite existing key files:" >&2
    [ -e "$priv" ] && echo "  $priv" >&2
    [ -e "$pub" ]  && echo "  $pub"  >&2
    echo "Remove them manually (with proper key-rotation discipline) and re-run." >&2
    exit 73
  fi

  command -v openssl >/dev/null 2>&1 || { echo "✗ need 'openssl' on the host" >&2; exit 1; }

  sudo openssl genrsa -out "$priv" 2048
  sudo openssl rsa -in "$priv" -pubout -out "$pub"
  sudo chmod 0400 "$priv"
  sudo chmod 0644 "$pub"
  sudo chown root:root "$priv" "$pub" 2>/dev/null || true

  echo "Wrote:"
  echo "  $priv  (private — keep on this box)"
  echo "  $pub   (public — commit to infra/app/jwt-keys/v1.pub.pem in the repo)"
  exit 0
fi

# ---------------------------------------------------------------- mode 2 (dev)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKSPACE="$(cd "$ROOT/../.." && pwd)"
WS_KEYS_DIR="${WORKSPACE}/.config/lectorium/jwt"
AUTH_SRC="${ROOT}/modules/services/auth"

# Allow override; default to standard dotfiles layout.
DOTFILES_CREDS="${LECTORIUM_DOTFILES_CREDS_DIR:-${HOME}/Projects/akdasa/dotfiles/source/dotfiles/personal/projects/jiva-studio/credentials}"
PRIV_FILE="$DOTFILES_CREDS/lectorium-auth-jwt-private.key"
PUB_FILE="$DOTFILES_CREDS/lectorium-auth-jwt-public.pem"

if [ ! -d "$DOTFILES_CREDS" ]; then
  echo "✗ dotfiles credentials dir not found: $DOTFILES_CREDS" >&2
  echo "  Set LECTORIUM_DOTFILES_CREDS_DIR or clone akdasa/dotfiles first." >&2
  echo "  (For prod key generation use: gen-jwt-keys.sh --prod.)" >&2
  exit 1
fi

if [ ! -f "$PRIV_FILE" ] || [ ! -f "$PUB_FILE" ]; then
  echo "→ Generating RSA-2048 keypair into $DOTFILES_CREDS"
  if command -v go >/dev/null 2>&1; then
    (cd "$AUTH_SRC" && go run ./cmd/auth genkeys "$DOTFILES_CREDS")
    # Rename to our canonical filenames (`auth genkeys` writes private.pem/public.pem).
    mv "$DOTFILES_CREDS/private.pem" "$PRIV_FILE"
    mv "$DOTFILES_CREDS/public.pem"  "$PUB_FILE"
  elif command -v openssl >/dev/null 2>&1; then
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIV_FILE"
    openssl rsa -in "$PRIV_FILE" -pubout -out "$PUB_FILE"
  else
    echo "✗ need either 'go' (preferred) or 'openssl' to generate keys" >&2
    exit 1
  fi
  chmod 600 "$PRIV_FILE"
  chmod 644 "$PUB_FILE"
  echo "✓ Wrote $PRIV_FILE + $PUB_FILE"
else
  echo "✓ JWT keys already exist at $DOTFILES_CREDS — skipping generation"
fi

# Wire workspace path as symlinks to the dotfiles file. deploy.sh and dev
# compose use the workspace path, so this keeps them backend-agnostic.
mkdir -p "$WS_KEYS_DIR"
chmod 700 "$WS_KEYS_DIR"
ln -snf "$PRIV_FILE" "$WS_KEYS_DIR/private.pem"
ln -snf "$PUB_FILE"  "$WS_KEYS_DIR/public.pem"
echo "✓ Symlinked $WS_KEYS_DIR/{private,public}.pem → dotfiles"

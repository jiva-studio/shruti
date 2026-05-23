#!/usr/bin/env bash
# Generate the workspace-wide JWT RSA keypair used by the auth service.
#
# Canonical storage: dotfiles repo at
#   $HOME/Projects/akdasa/dotfiles/.../credentials/lectorium-auth-jwt-{private.key,public.pem}
# (private encrypted by git-crypt via the *.key pattern; public is, well, public).
#
# Workspace path .config/lectorium/jwt/{private,public}.pem is materialized as
# symlinks into that dotfiles location — deploy.sh and dev compose read those
# symlinked paths, so existing code stays unchanged.
#
# Without persistent storage, regenerating keys would invalidate every issued
# refresh token (90-day TTL). The dotfiles repo is the source of truth so a
# fresh clone of the workspace inherits valid keys.
#
# Idempotent: skips generation if keys already exist in dotfiles.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKSPACE="$(cd "$ROOT/../.." && pwd)"
WS_KEYS_DIR="${WORKSPACE}/.config/lectorium/jwt"
AUTH_SRC="${ROOT}/modules/services/auth"

# Allow override; default to standard dotfiles layout.
DOTFILES_CREDS="${LECTORIUM_DOTFILES_CREDS_DIR:-${HOME}/Projects/akdasa/dotfiles/source/dotfiles/personal/projects/akdasa-studios/credentials}"
PRIV_FILE="$DOTFILES_CREDS/lectorium-auth-jwt-private.key"
PUB_FILE="$DOTFILES_CREDS/lectorium-auth-jwt-public.pem"

if [ ! -d "$DOTFILES_CREDS" ]; then
  echo "✗ dotfiles credentials dir not found: $DOTFILES_CREDS" >&2
  echo "  Set LECTORIUM_DOTFILES_CREDS_DIR or clone akdasa/dotfiles first." >&2
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

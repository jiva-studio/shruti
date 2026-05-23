#!/usr/bin/env bash
# infra/shared/lib/ssh-helpers.sh
# One-time SSH key install + sshd hardening for a freshly-provisioned VPS.
# Run interactively (uses password auth on first call), then becomes a no-op.
# shellcheck shell=bash

# ──────────────────────────────────────────────────────────────────────
# ssh_copy_id_once <user@host> <pubkey_path>
# ──────────────────────────────────────────────────────────────────────
# Pushes the public key via ssh-copy-id. Safe to re-run — duplicate keys
# are de-duped server-side.
ssh_copy_id_once() {
  local target="$1" pubkey="$2"
  [ -f "$pubkey" ] || { echo "✗ pubkey not found: $pubkey" >&2; return 1; }
  command -v ssh-copy-id >/dev/null 2>&1 || {
    echo "✗ ssh-copy-id not installed (openssh-client)" >&2; return 1;
  }
  echo "→ ssh-copy-id to $target (you may be prompted for the password)"
  ssh-copy-id -i "$pubkey" -o StrictHostKeyChecking=accept-new "$target"
  echo "✓ key installed; subsequent SSH should use the key"
}

# ──────────────────────────────────────────────────────────────────────
# ssh_harden_remote
# ──────────────────────────────────────────────────────────────────────
# Disables password auth + root password login on the remote host.
# Assumes you can already SSH via key (call ssh_copy_id_once first).
# Requires SSH_TARGET + SSH_OPTS to be set.
ssh_harden_remote() {
  log "Hardening sshd_config on $SSH_TARGET..."
  ssh_pipe <<'REMOTE'
set -euo pipefail
sshd_cfg=/etc/ssh/sshd_config
cp "$sshd_cfg" "${sshd_cfg}.bak.$(date +%Y%m%d-%H%M%S)"
sed -i -E \
  -e 's/^[# ]*PasswordAuthentication.*/PasswordAuthentication no/' \
  -e 's/^[# ]*PermitRootLogin.*/PermitRootLogin prohibit-password/' \
  -e 's/^[# ]*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' \
  "$sshd_cfg"

# Append if not present
grep -q '^PasswordAuthentication ' "$sshd_cfg" || echo 'PasswordAuthentication no' >> "$sshd_cfg"
grep -q '^PermitRootLogin '       "$sshd_cfg" || echo 'PermitRootLogin prohibit-password' >> "$sshd_cfg"

sshd -t && systemctl reload ssh
echo "✓ sshd hardened (password auth disabled)"
REMOTE
}

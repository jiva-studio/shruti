#!/usr/bin/env bash
set -euo pipefail

# Prints the newest Go version any module under modules/ asks for, from its
# `go` or `toolchain` directive. One toolchain at that version builds every
# module; an older go directive runs under a newer toolchain unchanged.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

git ls-files -z -- 'modules/*go.mod' \
  | xargs -0 awk '$1 == "go" { print $2 } $1 == "toolchain" { sub(/^go/, "", $2); print $2 }' \
  | sort -V \
  | tail -n 1

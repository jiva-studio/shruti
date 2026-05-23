#!/usr/bin/env bash
# infra/shared/lib/render-templates.sh
# Render *.template files via envsubst, dropping the .template suffix.
#
# Required env: any ${VAR} referenced inside templates must be exported.
# shellcheck shell=bash

# ──────────────────────────────────────────────────────────────────────
# render_templates_in <dir>
# ──────────────────────────────────────────────────────────────────────
# For every *.template under <dir> (recursively), produce a sibling file
# with the .template suffix removed, with ${VAR} substitutions applied.
# Only substitutes variables that are currently exported — others are
# left as literal `${...}` (envsubst default).
render_templates_in() {
  local dir="$1"
  command -v envsubst >/dev/null 2>&1 || {
    echo "✗ envsubst not found (apt install gettext)" >&2; return 1;
  }
  local f out
  while IFS= read -r -d '' f; do
    out="${f%.template}"
    envsubst < "$f" > "$out"
    echo "  · rendered $(basename "$out")"
  done < <(find "$dir" -type f -name '*.template' -print0)
}

# ──────────────────────────────────────────────────────────────────────
# require_vars <var1> [var2 ...]
# ──────────────────────────────────────────────────────────────────────
require_vars() {
  local v missing=0
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then
      echo "✗ required env var unset: $v" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || return 1
}

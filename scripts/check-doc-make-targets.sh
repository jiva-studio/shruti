#!/usr/bin/env bash
set -euo pipefail

# Every `make <target>` that AGENTS.md or a file under .agents/ tells an agent
# to run must be a target the root Makefile defines. `make -n` is the judge:
# it resolves the target without running it.
#
# A reference is `make` followed by a target name, optionally preceded by
# `-C "$REPO_ROOT"` or `-C .`. Variable assignments after the target
# (`PKG=…`) are ignored. References to another directory's Makefile
# (`make -C modules/tools …`) are checked against that Makefile.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

mapfile -t docs < <(git ls-files AGENTS.md '.agents/*.md')

# Only code counts: whole lines inside fenced blocks, and inline `code` spans
# elsewhere. Prose ("make the change") is not a command.
code="$(awk '
  FNR == 1 { fence = 0 }
  /^[[:space:]]*```/ { fence = !fence; next }
  fence { print FILENAME ":" FNR ":" $0; next }
  {
    line = $0
    while (match(line, /`[^`]+`/)) {
      print FILENAME ":" FNR ":" substr(line, RSTART + 1, RLENGTH - 2)
      line = substr(line, RSTART + RLENGTH)
    }
  }
' "${docs[@]}")"

refs="$(printf '%s\n' "$code" | grep -oE '^[^:]+:[0-9]+:|\bmake( -C [^ ]+)? [a-z][a-z0-9_-]*' \
  | awk '/^[^:]+:[0-9]+:$/ { loc = $0; next } { print loc $0 }' || true)"

missing=0
checked=0
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  location="${ref%%:make*}"
  cmd="make${ref#*:make}"
  dir="."
  if [[ "$cmd" =~ ^make\ -C\ ([^ ]+)\ (.+)$ ]]; then
    dir="${BASH_REMATCH[1]}"
    target="${BASH_REMATCH[2]}"
    case "$dir" in '"$REPO_ROOT"'|'$REPO_ROOT'|.) dir="." ;; esac
  else
    target="${cmd#make }"
  fi
  checked=$((checked + 1))
  if ! make -n -C "$dir" "$target" >/dev/null 2>&1; then
    echo "missing make target: '$target' (in $dir) referenced at $location"
    missing=$((missing + 1))
  fi
done <<< "$refs"

if [ "$missing" -ne 0 ]; then
  echo "check-doc-make-targets: $missing of $checked references name no target"
  exit 1
fi
echo "check-doc-make-targets: all $checked references resolve"

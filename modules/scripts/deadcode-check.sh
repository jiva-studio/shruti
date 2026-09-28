#!/usr/bin/env bash
# Report Go functions unreachable from any main or test in the modules under
# modules/, and compare them with modules/.deadcode-allowlist.
#
# Fails on a finding the allowlist does not name, and on an allowlist entry
# that is no longer found, so the list only shrinks. libs/pipeline is skipped:
# it is a library, and the modules that import it are its roots.
#
# Usage: modules/scripts/deadcode-check.sh   (from the repository root;
# needs `deadcode` from golang.org/x/tools/cmd/deadcode on PATH)
set -euo pipefail

allowlist=modules/.deadcode-allowlist
found=$(mktemp)
allowed=$(mktemp)
trap 'rm -f "$found" "$allowed"' EXIT

while IFS= read -r mod; do
  dir=$(dirname "$mod")
  [ "$dir" = modules/libs/pipeline ] && continue
  (cd "$dir" && deadcode -test -f '{{range .Funcs}}{{$.Path}} {{.Name}}{{"\n"}}{{end}}' ./...)
done < <(find modules -name go.mod -not -path '*/node_modules/*' | sort) | sort -u >"$found"

sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' "$allowlist" | sort -u >"$allowed"

status=0
new=$(comm -23 "$found" "$allowed")
gone=$(comm -13 "$found" "$allowed")
if [ -n "$new" ]; then
  echo "unreachable functions not in $allowlist — delete them or add an entry with a reason:"
  echo "$new"
  status=1
fi
if [ -n "$gone" ]; then
  echo "entries in $allowlist that are no longer unreachable — remove them:"
  echo "$gone"
  status=1
fi
[ $status -eq 0 ] && echo "deadcode: $(wc -l <"$found") known entries, nothing new"
exit $status

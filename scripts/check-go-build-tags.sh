#!/usr/bin/env bash
set -euo pipefail

# Fails when a Go file is guarded by a build tag that modules/.golangci.yml does
# not list under run.build-tags. golangci-lint compiles only the files the
# listed tags select, so a file behind any other tag is never linted and a
# layer rule never sees its imports.
#
# Platform names, go1.N versions, cgo and `ignore` (files never built) are not
# custom tags and are not required in the list. The gate fixtures are skipped:
# they are violations on purpose, copied into the tree only while checked.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

config=modules/.golangci.yml

listed="$(awk '
  /^run:/ { in_run = 1; next }
  in_run && /^[^ ]/ { in_run = 0 }
  in_run && /build-tags:/ { in_tags = 1; next }
  in_tags && /^ *- / { sub(/^ *- */, ""); print; next }
  in_tags { in_tags = 0 }
' "$config")"

builtin="$(go tool dist list | tr '/' '\n' | sort -u) cgo ignore unix"

status=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  for tag in $(sed -n 's#^//go:build ##p' "$file" | grep -oE '[A-Za-z_][A-Za-z0-9_.]*'); do
    case "$tag" in go1.*) continue ;; esac
    if printf '%s\n' $builtin $listed | grep -qxF "$tag"; then
      continue
    fi
    echo "$file: build tag '$tag' is not in run.build-tags in $config, so the linters never see this file" >&2
    status=1
  done
done < <(find modules -name '*.go' -not -path '*/node_modules/*' -not -path 'modules/tools/gate-fixtures/*' -print0 \
  | xargs -0 -r grep -l '^//go:build' --)

[ $status -eq 0 ] && echo "go build tags: every tag in the tree is linted"
exit $status

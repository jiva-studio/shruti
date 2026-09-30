#!/usr/bin/env bash
set -euo pipefail

# Fails on an exclusion rule in modules/.golangci.yml that no Go module uses.
#
# golangci-lint's `warn-unused` reports every rule that skipped nothing in the
# module being linted. The config is shared, so a rule written for one module
# is reported by all the others; a rule is stale only when every module
# reports it. The allowlists there may only shrink, and this is what makes an
# entry whose line is gone fail instead of lingering.
#
# Tool override: GOLANGCI_LINT.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -z "${GOLANGCI_LINT:-}" ]; then
  if command -v golangci-lint >/dev/null 2>&1; then
    GOLANGCI_LINT=golangci-lint
  else
    GOLANGCI_LINT="$(go env GOPATH 2>/dev/null)/bin/golangci-lint"
  fi
fi

if ! command -v "$GOLANGCI_LINT" >/dev/null 2>&1; then
  echo "golangci-lint not found at '$GOLANGCI_LINT'; install it or set GOLANGCI_LINT" >&2
  exit 2
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

modules=0
while IFS= read -r mod; do
  dir="$(dirname "$mod")"
  modules=$((modules + 1))
  # Lint findings (exit 1) are check-go's to report; only the unused-rule
  # warnings are read here. Any other exit means the linter itself failed.
  rc=0
  (cd "$dir" && "$GOLANGCI_LINT" run --allow-parallel-runners ./... >/dev/null 2>"$work/$modules.log") || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "golangci-lint failed in $dir (exit $rc):" >&2
    tail -n 20 "$work/$modules.log" >&2
    exit 2
  fi
  sed -n 's/.*Skipped 0 issues by rules: \[\(.*\)\]"$/\1/p' "$work/$modules.log" | sort -u >"$work/$modules.rules"
done < <(git ls-files -- 'modules/*go.mod' | sort)

if [ "$modules" = 0 ] || [ -z "$(cat "$work"/*.rules)" ]; then
  echo "no module reported its exclusion rules; golangci-lint read nothing" >&2
  exit 2
fi

stale="$(cat "$work"/*.rules | sort | uniq -c | awk -v n="$modules" '$1 == n { $1 = ""; sub(/^ /, ""); print }')"
if [ -n "$stale" ]; then
  echo "exclusion rules in modules/.golangci.yml that match nothing in any module — delete them:" >&2
  printf '  %s\n' "$stale" >&2
  exit 1
fi
echo "go lint exclusions: every rule is used by some module"

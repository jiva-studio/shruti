#!/usr/bin/env bash
set -euo pipefail

# The layer rules, run through the tools that own them, then the self-test that
# proves each of those tools still refuses a known violation:
#
#   Python (chat)  modules/services/chat/app/tests/test_layering.py
#   Go             depguard, configured in modules/.golangci.yml, in every module,
#                  and no file behind a build tag the linters are not run with
#   TypeScript     dependency-cruiser, with the configuration that lives beside
#                  the code it checks; the mobile app's must be present
#   self-test      modules/tools/gate-fixtures/run.py
#
# Every section runs and the script fails at the end if any did, so one report
# names every broken layer.
#
# Tool overrides: GOLANGCI_LINT, UV.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

UV="${UV:-uv}"
if [ -z "${GOLANGCI_LINT:-}" ]; then
  if command -v golangci-lint >/dev/null 2>&1; then
    GOLANGCI_LINT=golangci-lint
  else
    GOLANGCI_LINT="$(go env GOPATH 2>/dev/null)/bin/golangci-lint"
  fi
fi

failed=()

section() { echo; echo "=== $1"; }

section "python: chat test_layering"
if ! (cd modules/services/chat/app && "$UV" run --locked --extra dev python -m pytest tests/test_layering.py -q -p no:cacheprovider); then
  failed+=("chat test_layering")
fi

section "go: depguard"
while IFS= read -r mod; do
  dir="$(dirname "$mod")"
  echo "--- $dir"
  # With one linter enabled, every exclusion rule for the others is reported
  # unused; scripts/check-go-lint-exclusions.sh is what reads those reports.
  if ! (cd "$dir" && "$GOLANGCI_LINT" run --allow-parallel-runners --enable-only depguard ./... \
    2> >(grep -v 'Skipped 0 issues by rules' >&2)); then
    failed+=("depguard $dir")
  fi
done < <(git ls-files -- 'modules/*go.mod' | sort)

section "go: build tags"
if ! ./scripts/check-go-build-tags.sh; then
  failed+=("go build tags")
fi

section "typescript: dependency-cruiser"
if [ ! -f modules/apps/mobile/.dependency-cruiser.cjs ]; then
  echo "modules/apps/mobile/.dependency-cruiser.cjs is missing: the app's layers go unchecked"
  failed+=("dependency-cruiser config")
fi
cruiser_configs="$(git ls-files -- '*.dependency-cruiser.cjs' '*.dependency-cruiser.js' '*.dependency-cruiser.mjs')"
if [ -z "$cruiser_configs" ]; then
  echo "no dependency-cruiser configuration in the tree"
  failed+=("dependency-cruiser config")
else
  while IFS= read -r cfg; do
    dir="$(dirname "$cfg")"
    echo "--- $cfg"
    if ! (cd "$dir" && { [ -d node_modules ] || npm ci; } && npx --no-install depcruise --config "$(basename "$cfg")" --output-type err .); then
      failed+=("dependency-cruiser $cfg")
    fi
  done <<< "$cruiser_configs"
fi

section "self-test: gate fixtures"
if ! "$UV" run --no-project python modules/tools/gate-fixtures/run.py; then
  failed+=("gate fixtures")
fi

echo
if [ ${#failed[@]} -ne 0 ]; then
  echo "check-architecture FAILED:"
  printf '  %s\n' "${failed[@]}"
  exit 1
fi
echo "check-architecture: all layer gates green"

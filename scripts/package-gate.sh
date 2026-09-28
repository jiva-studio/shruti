#!/usr/bin/env bash
set -euo pipefail

# Runs one gate over one package, choosing the toolchain from what the package
# declares:
#
#   package-gate.sh check    <PKG>   everything the package is held to
#   package-gate.sh test     <PKG>   its tests only
#   package-gate.sh coverage <PKG>   its tests with coverage
#   package-gate.sh red      <PKG>   exits 0 only if its tests run and fail
#
# <PKG> `@task` is the active band task's done.yaml target
# (scripts/band-task-target.sh). Otherwise <PKG> is a path (modules/services/auth, modules/apps/mobile/usecases, …) or a
# short name resolved against modules/ and modules/{apps,services,tools,libs}/. A path inside
# a package resolves to the nearest enclosing directory holding a go.mod,
# pyproject.toml or package.json. The chat service resolves to its app/.
#
# The TypeScript libraries under modules/libs/ have no toolchain of their own:
# the mobile app compiles, lints and tests them, so they resolve to it.
#
# Tool overrides: GOLANGCI_LINT, UV, NPM.

usage() {
  echo "usage: $(basename "$0") <check|test|coverage|red> <PKG>" >&2
  exit 2
}

MODE="${1:-}"
PKG="${2:-}"
[ -n "$MODE" ] && [ -n "$PKG" ] || usage
case "$MODE" in check|test|coverage|red) ;; *) usage ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

[ "$PKG" = "@task" ] && PKG="$(./scripts/band-task-target.sh)"

UV="${UV:-uv}"
NPM="${NPM:-npm}"
if [ -z "${GOLANGCI_LINT:-}" ]; then
  if command -v golangci-lint >/dev/null 2>&1; then
    GOLANGCI_LINT=golangci-lint
  else
    GOLANGCI_LINT="$(go env GOPATH 2>/dev/null)/bin/golangci-lint"
  fi
fi

resolve_dir() {
  local p="${1%/}"
  if [ -d "$p" ]; then
    printf '%s\n' "$p"
    return
  fi
  local base
  for base in modules modules/apps modules/services modules/tools modules/libs; do
    if [ -d "$base/$p" ]; then
      printf '%s\n' "$base/$p"
      return
    fi
  done
  echo "package-gate: no such package: $1" >&2
  exit 2
}

# Nearest directory at or above $1 that declares a toolchain.
find_root() {
  local d
  d="$(cd "$1" && pwd)"
  while [ "$d" != "/" ] && [ "${d#"$REPO_ROOT"}" != "$d" ]; do
    if [ -f "$d/go.mod" ] || [ -f "$d/pyproject.toml" ] || [ -f "$d/package.json" ]; then
      printf '%s\n' "${d#"$REPO_ROOT"/}"
      return
    fi
    d="$(dirname "$d")"
  done
  echo "package-gate: $1 has no go.mod, pyproject.toml or package.json at or above it" >&2
  exit 2
}

DIR="$(resolve_dir "$PKG")"
[ -f "$DIR/app/pyproject.toml" ] && DIR="$DIR/app"
case "$DIR" in
  modules/libs/*)
    # A Go library under libs/ carries its own go.mod; the TypeScript ones do not.
    lib="$(printf '%s\n' "$DIR" | cut -d/ -f1-3)"
    [ -f "$lib/go.mod" ] || DIR=modules/apps/mobile
    ;;
esac
ROOT="$(find_root "$DIR")"

# A red run passes only on a real test failure: an unresolvable package has
# already exited non-zero above, and passing tests are refused.
if [ "$MODE" = red ]; then
  if "${BASH_SOURCE[0]}" test "$ROOT"; then
    echo "package-gate: $ROOT tests pass; the red phase needs a failing test" >&2
    exit 1
  fi
  echo "package-gate: $ROOT tests fail, as the red phase requires"
  exit 0
fi

has_script() {
  (cd "$1" && node -e 'process.exit(require("./package.json").scripts?.[process.argv[1]] ? 0 : 1)' "$2")
}

gate_go() {
  local dir="$1"
  echo "[package-gate] go $MODE: $dir"
  cd "$REPO_ROOT/$dir"
  case "$MODE" in
    check)
      local unformatted
      unformatted="$(gofmt -l .)"
      if [ -n "$unformatted" ]; then
        echo "gofmt: unformatted files:" >&2
        echo "$unformatted" >&2
        return 1
      fi
      go vet ./...
      "$GOLANGCI_LINT" run --allow-parallel-runners ./...
      go test ./... -race -count=1
      ;;
    test)
      go test ./... -count=1
      ;;
    coverage)
      go test ./... -count=1 -coverprofile=coverage.out
      go tool cover -func=coverage.out | tail -n 1
      ;;
  esac
}

gate_python() {
  local dir="$1"
  echo "[package-gate] python $MODE: $dir"
  cd "$REPO_ROOT/$dir"
  "$UV" sync --locked --extra dev
  case "$MODE" in
    check)
      "$UV" run --no-sync ruff check .
      if [ -f scripts/check_mypy.py ]; then
        "$UV" run --no-sync python scripts/check_mypy.py
      fi
      if [ -f scripts/check_coverage_floors.py ]; then
        "$UV" run --no-sync python -m pytest tests -q --cov --cov-report=json
        "$UV" run --no-sync python scripts/check_coverage_floors.py
      else
        "$UV" run --no-sync python -m pytest tests -q
      fi
      ;;
    test)
      "$UV" run --no-sync python -m pytest tests -q
      ;;
    coverage)
      "$UV" run --no-sync python -m pytest tests -q --cov --cov-report=json
      if [ -f scripts/check_coverage_floors.py ]; then
        "$UV" run --no-sync python scripts/check_coverage_floors.py
      fi
      ;;
  esac
}

gate_node() {
  local dir="$1"
  echo "[package-gate] node $MODE: $dir"
  cd "$REPO_ROOT/$dir"
  [ -d node_modules ] || "$NPM" ci
  local ran=0 s
  case "$MODE" in
    check)
      for s in lint typecheck check test depcruise knip; do
        if has_script . "$s"; then "$NPM" run "$s"; ran=1; fi
      done
      ;;
    test)
      if has_script . test; then "$NPM" test; ran=1; fi
      ;;
    coverage)
      if has_script . test:coverage; then "$NPM" run test:coverage; ran=1; fi
      ;;
  esac
  if [ "$ran" = 0 ]; then
    echo "package-gate: $dir declares no script for '$MODE'" >&2
    return 1
  fi
}

if [ -f "$ROOT/go.mod" ]; then
  gate_go "$ROOT"
elif [ -f "$ROOT/pyproject.toml" ]; then
  gate_python "$ROOT"
else
  gate_node "$ROOT"
fi

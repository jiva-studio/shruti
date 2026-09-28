#!/usr/bin/env bash
set -euo pipefail

# Prints the `target` of the active band task's done.yaml. The pipelines in
# .agents/pipelines/ pass PKG=@task because band hands claim params to make
# literally; the package and mutation gates resolve it here.
#
# The active task is the one named after the branch (slashes as dashes, or the
# slug after `task/`), else the only task whose state.json is in_progress.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASKS="$REPO_ROOT/.agents/tasks"

branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
spec=""
for slug in "${branch//\//-}" "${branch#task/}"; do
  if [ -n "$slug" ] && [ -f "$TASKS/$slug/done.yaml" ]; then
    spec="$TASKS/$slug/done.yaml"
    break
  fi
done

if [ -z "$spec" ] && [ -d "$TASKS" ]; then
  mapfile -t active < <(grep -lE '"status": *"in_progress"' "$TASKS"/*/state.json 2>/dev/null || true)
  if [ "${#active[@]}" -eq 1 ] && [ -f "$(dirname "${active[0]}")/done.yaml" ]; then
    spec="$(dirname "${active[0]}")/done.yaml"
  fi
fi

if [ -z "$spec" ]; then
  echo "band-task-target: no active task: no .agents/tasks/<branch>/done.yaml and not exactly one in_progress state.json" >&2
  exit 2
fi

target="$(sed -n 's/^target:[[:space:]]*//p' "$spec" | head -n 1 | sed 's/[[:space:]]#.*$//; s/^["'\'']//; s/["'\''][[:space:]]*$//; s/[[:space:]]*$//')"
if [ -z "$target" ]; then
  echo "band-task-target: $spec declares no top-level target" >&2
  exit 2
fi
printf '%s\n' "$target"

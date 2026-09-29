#!/usr/bin/env bash
set -euo pipefail

# Every shared library a service image COPYs must rebuild that image when it
# changes: .github/workflows/services-ghcr.yml has to list the library both in
# its push trigger paths and in the service's own paths-filter entry. A missing
# path means a library fix lands on main and the image keeps the old code.
#
# Services the workflow does not build (no paths-filter entry) are skipped.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

wf=.github/workflows/services-ghcr.yml
push_paths="$(awk '/^on:/ { on = 1 } on && /^  workflow_dispatch:/ { exit } on' "$wf")"

# filter_block prints the paths-filter entry that lists the given path.
filter_block() {
  awk -v own="- '$1'" '
    function flush() { if (hit) printf "%s", block; block = ""; hit = 0 }
    /^            [a-z0-9-]+:[[:space:]]*$/ { flush() }
    /^            / { block = block $0 "\n"; if (index($0, own)) hit = 1; next }
    { flush() }
    END { flush() }
  ' "$wf"
}

failed=0
for dockerfile in modules/services/*/Dockerfile; do
  svc="$(basename "$(dirname "$dockerfile")")"
  block="$(filter_block "modules/services/$svc/**")"
  [ -n "$block" ] || continue
  for lib in $(sed -n 's|^COPY libs/\([^/]*\)/.*|\1|p' "$dockerfile" | sort -u); do
    want="'modules/libs/$lib/**'"
    if ! grep -qF -- "- $want" <<<"$push_paths"; then
      echo "$wf: on.push.paths is missing $want ($svc COPYs it)"
      failed=1
    fi
    if ! grep -qF -- "- $want" <<<"$block"; then
      echo "$wf: the $svc paths-filter entry is missing $want"
      failed=1
    fi
  done
done
exit "$failed"

#!/usr/bin/env bash
# Recreate the local-only E2E fixtures (gitignored binaries).
#
#   - content.db   : a snapshot of the published catalog DB.
#   - user-en.db   : seeded user DB (playlist, history, notes) — EN.
#   - user-ru.db   : seeded user DB — RU.
#
# The two user DBs are produced by the screenshot pipeline's fixture generator,
# so we generate them there once and copy them over. The catalog snapshot comes
# from the local lake output.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # tests/e2e/mobile
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"                     # …/shruti
SHOTS="$REPO_ROOT/modules/tools/screenshots"
FIX="$HERE/fixtures"
mkdir -p "$FIX"

# content.db: local lake → screenshot fixture → published CDN (CI path).
PUBLIC_BASE="${SHRUTI_PUBLIC_BASE:-https://cdn-s3.shruti.local}"
CATALOG="$REPO_ROOT/resources/lake-out/artifacts/catalog/current.db"
if [[ -f "$CATALOG" ]]; then
  cp "$CATALOG" "$FIX/content.db"
elif [[ -f "$SHOTS/fixtures/content.db" ]]; then
  cp "$SHOTS/fixtures/content.db" "$FIX/content.db"
else
  echo ">> fetching published catalog from $PUBLIC_BASE"
  VER="$(curl -fsSL "$PUBLIC_BASE/public/config.json" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["databases"][0]["version"])')"
  curl -fsSL "$PUBLIC_BASE/public/db/shruti.$VER.db" -o "$FIX/content.db"
fi

# Reuse the screenshot pipeline's seeded user DBs (generate them if absent).
if [[ ! -f "$SHOTS/fixtures/user-en.db" || ! -f "$SHOTS/fixtures/user-ru.db" ]]; then
  echo ">> generating user fixtures via screenshots pipeline"
  ( cd "$SHOTS" && npm run generate-user-fixture )
fi
cp "$SHOTS/fixtures/user-en.db" "$FIX/user-en.db"
cp "$SHOTS/fixtures/user-ru.db" "$FIX/user-ru.db"

echo ">> fixtures ready in $FIX"
ls -la "$FIX"

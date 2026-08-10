#!/usr/bin/env bash
# Recreate the local-only E2E fixtures (the gitignored user DBs).
#
#   - user-en.db   : seeded user DB (playlist, history, notes) — EN.
#   - user-ru.db   : seeded user DB — RU.
#   - …plus the .clean / .single variants.
#
# The user DBs are produced by the screenshot pipeline's fixture generator, so
# we generate them there once and copy them over. They are deliberately NOT
# committed: the activity heatmap reads the real clock, so their listening
# history is anchored to the local midnight of the day they were generated.
#
# The catalog fixture is NOT built here. `fixtures/content.db` is a committed
# test asset — see scripts/build-catalog-fixture.py, which a human runs when
# the corpus is deliberately moved. This script therefore needs NO network:
# nothing below reaches a backend, least of all the production origin.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # tests/e2e/mobile
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"                     # …/shruti
SHOTS="$REPO_ROOT/modules/tools/screenshots"
FIX="$HERE/fixtures"
mkdir -p "$FIX"

# The committed catalog must be the one the recorded digest describes: a copy
# left behind by the old generating script (or half-written by a failed
# checkout) would silently change what every spec runs against.
python3 - "$FIX/content.db" "$FIX/content.db.json" <<'PY'
import hashlib, json, sys
db, meta = sys.argv[1], sys.argv[2]
expected = json.load(open(meta))["sha256"]
h = hashlib.sha256()
with open(db, "rb") as fh:
    for chunk in iter(lambda: fh.read(1 << 20), b""):
        h.update(chunk)
if h.hexdigest() != expected:
    sys.exit(
        f"{db} does not match the digest in {meta}.\n"
        f"  expected {expected}\n  actual   {h.hexdigest()}\n"
        "Restore it with `git checkout -- fixtures/content.db`, or rebuild it "
        "deliberately with scripts/build-catalog-fixture.py and commit both files."
    )
print(f">> catalog fixture verified ({expected[:12]}…)")
PY

# Reuse the screenshot pipeline's seeded user DBs (generate them if absent).
# Two strategies: `preseed` (full demo dataset) and `clean` (schema + config
# only) for specs that bring their own state.
if [[ ! -f "$SHOTS/fixtures/user-en.db" || ! -f "$SHOTS/fixtures/user-ru.db" ]]; then
  echo ">> generating seeded user fixtures via screenshots pipeline"
  ( cd "$SHOTS" && npm run generate-user-fixture )
fi
if [[ ! -f "$SHOTS/fixtures/user-en.clean.db" || ! -f "$SHOTS/fixtures/user-ru.clean.db" ]]; then
  echo ">> generating clean user fixtures via screenshots pipeline"
  ( cd "$SHOTS" && npm run generate-user-fixture -- --clean )
fi
if [[ ! -f "$SHOTS/fixtures/user-en.single.db" || ! -f "$SHOTS/fixtures/user-ru.single.db" ]]; then
  echo ">> generating single-track user fixtures via screenshots pipeline"
  ( cd "$SHOTS" && npm run generate-user-fixture -- --strategy=single )
fi
cp "$SHOTS/fixtures/user-en.db" "$FIX/user-en.db"
cp "$SHOTS/fixtures/user-ru.db" "$FIX/user-ru.db"
cp "$SHOTS/fixtures/user-en.clean.db" "$FIX/user-en.clean.db"
cp "$SHOTS/fixtures/user-ru.clean.db" "$FIX/user-ru.clean.db"
cp "$SHOTS/fixtures/user-en.single.db" "$FIX/user-en.single.db"
cp "$SHOTS/fixtures/user-ru.single.db" "$FIX/user-ru.single.db"

echo ">> fixtures ready in $FIX"
ls -la "$FIX"

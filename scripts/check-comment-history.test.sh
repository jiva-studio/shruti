#!/usr/bin/env bash
set -euo pipefail

# Self-test for check-comment-history.sh. In a scratch repository it adds the
# fixtures under scripts/testdata/comment-history/ on top of an empty commit:
#
#   - flagged.* and clean.* together must fail, naming exactly the lines in
#     expected.txt;
#   - clean.* alone must pass.
#
# testdata/ is added to both and must never be reported.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures="$REPO_ROOT/scripts/testdata/comment-history"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Builds a scratch repository in $1 holding the files matching $2.
scratch_repo() {
  local dir="$1" glob="$2"
  mkdir -p "$dir/scripts"
  cp "$REPO_ROOT/scripts/check-comment-history.sh" "$dir/scripts/"
  git -C "$dir" init -q
  git -C "$dir" -c user.name=fixture -c user.email=fixture@example.com -c commit.gpgsign=false \
    commit -q --allow-empty -m base
  # shellcheck disable=SC2086
  cp $fixtures/$glob "$dir/"
  cp -r "$fixtures/testdata" "$dir/"
  git -C "$dir" add -A
}

scratch_repo "$work/mixed" '*.*'
rm "$work/mixed/expected.txt"
git -C "$work/mixed" add -A
if out="$(BASE=HEAD "$work/mixed/scripts/check-comment-history.sh")"; then
  echo "check-comment-history.test: flagged fixtures passed the check"
  exit 1
fi
got="$(printf '%s\n' "$out" | grep -oE '^[^: ]+:[0-9]+' | sort)"
want="$(sort "$fixtures/expected.txt")"
if [ "$got" != "$want" ]; then
  echo "check-comment-history.test: flagged lines differ from expected.txt"
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") || true
  exit 1
fi

scratch_repo "$work/clean" 'clean.*'
if ! out="$(BASE=HEAD "$work/clean/scripts/check-comment-history.sh")"; then
  printf '%s\n' "$out"
  echo "check-comment-history.test: clean fixtures failed the check"
  exit 1
fi

echo "check-comment-history.test: $(wc -l < "$fixtures/expected.txt") flagged lines found, clean fixtures pass"

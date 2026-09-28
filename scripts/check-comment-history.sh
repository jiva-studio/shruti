#!/usr/bin/env bash
set -euo pipefail

# Fails when a comment line added since the base narrates history instead of
# describing the code (.agents/rules/comments.md): "used to", "previously",
# "no longer", "today", a phase or an issue number, and the like.
#
# Only added lines are read, and only their comment part: `//`, `/* */` and
# `*` continuation lines, `#`, `--` in SQL, `<!-- -->`, and Python docstrings.
# Prose in Markdown, code outside comments, `code spans` inside them and files
# under a testdata/ directory (verbatim data) are not checked.
#
# Phrases that also describe runtime behaviour are narrowed so that reading
# stays quiet: a passive "is used to", "superseded" only as "superseded by",
# "today's" (a daily quota) not at all, and "was added/removed/changed" only
# when followed by in, after, before, because, since, back or during.
#
# The base is the merge-base of HEAD with $BASE, or with origin/main (main when
# there is no origin). The diff runs against the working tree, so uncommitted
# edits count too.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

upstream="${BASE:-origin/main}"
if [ -z "${BASE:-}" ] && ! git rev-parse -q --verify "$upstream^{commit}" >/dev/null; then
  upstream=main
fi
BASE="$(git merge-base HEAD "$upstream")"

# This script and its test fixtures quote the phrases on purpose.
self=(":(exclude)scripts/check-comment-history.sh" ":(exclude)scripts/testdata/comment-history/"
  ":(exclude,glob)**/testdata/**")

found="$(git diff -U0 --no-color --no-ext-diff "$BASE" -- . "${self[@]}" | awk '
  function ext_of(p,   n) {
    n = p; sub(/.*\//, "", n)
    if (n == "Makefile" || n ~ /\.mk$/) return "hash"
    if (n !~ /\./) return ""
    sub(/.*\./, "", n)
    if (n ~ /^(go|ts|tsx|js|jsx|mjs|cjs|rs|swift|kt|java|c|h|cc|cpp|css|scss)$/) return "slash"
    if (n == "vue") return "vue"
    if (n == "py") return "py"
    if (n ~ /^(sh|bash|yml|yaml|toml|nix|rb|conf|env)$/) return "hash"
    if (n == "sql") return "sql"
    return ""
  }
  # The comment part of an added line, or "" when it has none.
  function comment_of(s, kind,   t, i, q) {
    t = s; sub(/^[ \t]+/, "", t)
    if (kind == "py") {
      q = gsub(/"""|'"'''"'/, "&", s)
      if (indoc || q > 0) {
        if (q % 2 == 1) indoc = !indoc
        return s
      }
    }
    if (kind == "slash" || kind == "vue") {
      if (inblock) { if (index(s, "*/")) inblock = 0; return s }
      if (t ~ /^\/\*/) { if (!index(t, "*/")) inblock = 1; return t }
      if (t ~ /^\*/) return t
      if (match(s, /(^|[ \t])\/\//)) return substr(s, RSTART)
    }
    if (kind == "vue") {
      if (inhtml) { if (index(s, "-->")) inhtml = 0; return s }
      if (i = index(s, "<!--")) { if (!index(s, "-->")) inhtml = 1; return substr(s, i) }
    }
    if (kind == "hash" || kind == "py") {
      if (t ~ /^#/) return t
      if (match(s, /[ \t]#[ \t]/)) return substr(s, RSTART)
    }
    if (kind == "sql" && match(s, /(^|[ \t])--/)) return substr(s, RSTART)
    return ""
  }
  /^\+\+\+ / { path = substr($0, 7); kind = ext_of(path); indoc = inblock = inhtml = 0; next }
  /^@@ / {
    split($3, a, ","); line = substr(a[1], 2) + 0
    indoc = inblock = inhtml = 0
    next
  }
  /^\+/ {
    s = substr($0, 2); cur = line++
    if (kind == "") next
    c = tolower(comment_of(s, kind))
    if (c == "") next
    gsub(/`[^`]*`/, "", c)
    gsub(/(is|are|be|been|being|was|were|get|gets|got)( [a-z]+ly)? used to/, "", c)
    gsub(/today.s/, "", c)
    if (c ~ /(^|[^a-z0-9_])(used to|previously|no longer|superseded by|legacy|was (added|removed|changed) (in|after|before|because|since|back|during)|phase [0-9]|pr #|issue #|today|back then|historically)([^a-z0-9_]|$)/ ||
        c ~ /(^|[ \t(])#[0-9][0-9]+([^0-9a-z_]|$)/) {
      t = s; sub(/^[ \t]+/, "", t)
      printf "%s:%d: %s\n", path, cur, t
    }
  }
')"

if [ -n "$found" ]; then
  printf '%s\n' "$found"
  echo
  echo "check-comment-history: $(printf '%s\n' "$found" | wc -l) added comment line(s) narrate history;"
  echo "describe what the code does now and why (.agents/rules/comments.md)."
  exit 1
fi
echo "check-comment-history: no added comment narrates history (base $(git rev-parse --short "$BASE"))"

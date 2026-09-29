"""Every relative link in docs/**/*.md, AGENTS.md and .agents/**/*.md must resolve.

A link resolves against its file's directory; a leading `/` means the docs root
for files under docs/ (docsify) and the repository root elsewhere. A link to a
directory counts. Anchors, queries, URLs with a scheme and code are ignored.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

INLINE = re.compile(r"!?\[(?:[^\]\[]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+\"[^\"]*\")?\s*\)")
REFERENCE = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)")
HREF = re.compile(r"""<(?:a|img)\b[^>]*?\b(?:href|src)=["']([^"']+)["']""")
SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:|^//")
FENCE = re.compile(r"^\s*(```|~~~)")
CODE_SPAN = re.compile(r"`+[^`]*`+")


def files() -> list[Path]:
    found = [ROOT / "AGENTS.md"]
    for base in (DOCS, ROOT / ".agents"):
        found += [p for p in base.rglob("*.md") if "node_modules" not in p.parts]
    return sorted(set(p for p in found if p.is_file()))


def targets(text: str):
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        if FENCE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        line = CODE_SPAN.sub("", line)
        for pattern in (INLINE, REFERENCE, HREF):
            for match in pattern.finditer(line):
                yield number, match.group(1).strip("<>")


def resolves(source: Path, target: str) -> bool:
    path = unquote(target.split("#", 1)[0].split("?", 1)[0])
    if not path:
        return True
    if path.startswith("/"):
        base = DOCS if source.is_relative_to(DOCS) else ROOT
        return (base / path.lstrip("/")).exists()
    return (source.parent / path).exists()


def main() -> int:
    broken = 0
    checked = 0
    for source in files():
        for number, target in targets(source.read_text(encoding="utf-8")):
            if SCHEME.match(target) or target.startswith("#"):
                continue
            checked += 1
            if not resolves(source, target):
                broken += 1
                print(f"{source.relative_to(ROOT)}:{number}: broken link: {target}")
    if broken:
        print(f"check-doc-links: {broken} of {checked} relative links do not resolve")
        return 1
    print(f"check-doc-links: all {checked} relative links resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())

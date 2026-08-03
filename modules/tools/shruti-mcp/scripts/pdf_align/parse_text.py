"""Parse a plain-text or HTML transcript into the same block stream parse_pdf
produces, so the aligner can project ASR timings onto it unchanged.

Importers that carry an editor-proofread transcript (goswami.ru publishes one
for roughly a third of its archive) need no LLM review at all — the text is
already correct and only lacks timings.
"""
from __future__ import annotations

import html
import re
from pathlib import Path

# A block-level tag ends a paragraph; everything else is dropped with its tags.
_BLOCK_END = re.compile(
    r"</\s*(?:p|div|br|h[1-6]|li|tr|blockquote)\s*>|<\s*br\s*/?>", re.I)
_TAG = re.compile(r"<[^>]+>")
_SCRIPTY = re.compile(r"<(script|style)\b.*?</\1\s*>", re.I | re.S)

# A line that is only a verse: Devanagari/Bengali, or IAST with diacritics and
# no sentence punctuation. Kept as its own block so it is not spoken over.
_VERSE_LINE = re.compile(
    r"^[\sऀ-ॿঀ-৿]+$|"
    r"^[^.!?]{,120}[āīūṛṝḷḹṅñṭḍṇśṣḥṁ][^.!?]{,120}$")


def _paragraphs(raw: str, is_html: bool) -> list[str]:
    if is_html:
        raw = _SCRIPTY.sub(" ", raw)
        raw = _BLOCK_END.sub("\n\n", raw)
        raw = _TAG.sub("", raw)
        raw = html.unescape(raw)
    raw = raw.replace(" ", " ")
    out = []
    for chunk in re.split(r"\n\s*\n+", raw):
        text = re.sub(r"[ \t]+", " ", chunk).strip()
        if text:
            out.append(text)
    return out


def parse_text(path: str | Path) -> dict:
    """Return {"blocks": [...]} in parse_pdf's shape."""
    p = Path(path)
    raw = p.read_text(encoding="utf-8", errors="replace")
    paras = _paragraphs(raw, p.suffix.lower() in (".html", ".htm"))

    blocks = []
    for text in paras:
        lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
        if lines and all(_VERSE_LINE.match(ln) for ln in lines):
            blocks.append({"kind": "verse", "lines": lines, "ref": None})
        else:
            blocks.append({"kind": "para", "lines": lines,
                           "speaker": None, "ref": None})
    return {"blocks": blocks, "duration_ms": None, "header_lines": []}

"""Extract a *raw* title hint from a transcript PDF's first-page header.

Returns the first bold@16 centered line on page 1, IAST-converted, or None
when no such line exists. Performs no templated/book-ref filtering — that
judgment is the LLM's job (it sees REFERENCES + KIND alongside the hint
and can decide whether the hint duplicates them).
"""
from __future__ import annotations
from pathlib import Path
from .parse_pdf import parse_pdf
from .iast import to_iast


def extract_header_hint(pdf_path: str | Path) -> str | None:
    parsed = parse_pdf(Path(pdf_path))
    for line in parsed.get("header_lines") or []:
        s = (line or "").strip()
        if not s or s == "—":
            continue
        return to_iast(s)
    return None

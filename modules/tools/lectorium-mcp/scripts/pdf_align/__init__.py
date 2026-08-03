"""pdf_align — align canonical PDF transcript to noisy ASR segments.

Public API:
  - align_track(pdf_path, raw_json_path, language="en") -> dict
    Returns a v2 transcript {trackId, language, version, blocks[]} ready to
    write to public/tracks/{id}/transcripts/{lang}.json.
"""
from __future__ import annotations
import json
from pathlib import Path
from .align_fast import align_track_fast

def align_track(pdf_path: str | Path, raw_json_path: str | Path, language: str = "en") -> dict:
    # imported here so a text-only lake needs no PDF library
    from .parse_pdf import parse_pdf
    parsed = parse_pdf(Path(pdf_path))
    raw = json.loads(Path(raw_json_path).read_text())
    out = align_track_fast(parsed, raw)
    out["language"] = language
    return out


def align_track_text(text_path: str | Path, raw_json_path: str | Path,
                     language: str = "ru") -> dict:
    """Same alignment against a plain-text or HTML transcript instead of a PDF."""
    from .parse_text import parse_text
    parsed = parse_text(Path(text_path))
    raw = json.loads(Path(raw_json_path).read_text())
    out = align_track_fast(parsed, raw)
    out["language"] = language
    return out

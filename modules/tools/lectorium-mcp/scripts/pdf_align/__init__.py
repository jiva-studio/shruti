"""pdf_align — align canonical PDF transcript to noisy ASR segments.

Public API:
  - align_track(pdf_path, raw_json_path, language="en") -> dict
    Returns a v2 transcript {trackId, language, version, blocks[]} ready to
    write to public/tracks/{id}/transcripts/{lang}.json.
"""
from __future__ import annotations
import json
from pathlib import Path
from .parse_pdf import parse_pdf
from .align_fast import align_track_fast

def align_track(pdf_path: str | Path, raw_json_path: str | Path, language: str = "en") -> dict:
    parsed = parse_pdf(Path(pdf_path))
    raw = json.loads(Path(raw_json_path).read_text())
    out = align_track_fast(parsed, raw)
    out["language"] = language
    return out

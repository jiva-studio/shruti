#!/usr/bin/env python3
"""Smoke-test the chunker on a real Shruti transcript.

Run from `agent/`:
    PYTHONPATH=app/src python3 scripts/smoke_chunker.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow running without install: add app/src to path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "app" / "src"))

from shruti_chat.indexer.chunker import chunk_reviewed  # noqa: E402


def main() -> None:
    raw = Path(
        "/home/akd/Projects/jiva-studio/shruti/resources/lake-out/"
        "artifacts/tracks/track_01OfAcZgK1wX/transcripts/ru/raw.json"
    )
    data = json.loads(raw.read_text(encoding="utf-8"))
    # `raw.json` is segments-shaped; lift it to a Reviewed-like envelope.
    blocks = [
        {"type": "sentence", "start": s["start"], "end": s["end"], "text": s["text"]}
        for s in data.get("segments", [])
    ]
    reviewed = {
        "trackId": data.get("trackId", "track_test"),
        "language": data.get("language", "ru"),
        "blocks": blocks,
    }
    chunks = chunk_reviewed(reviewed)
    print(f"segments_in={len(blocks)}, chunks_out={len(chunks)}")
    for i, c in enumerate(chunks[:3]):
        dur_s = (c.end_ms - c.start_ms) / 1000
        print(f"  chunk {i}: {dur_s:.1f}s @ {c.start_ms} → {c.end_ms}")
        print(f"            text[:80]: {c.text[:80]!r}")
    if chunks:
        avg = sum(c.end_ms - c.start_ms for c in chunks) / len(chunks) / 1000
        print(f"avg_window_s = {avg:.1f}")


if __name__ == "__main__":
    main()

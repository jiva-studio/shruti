"""Reviewed-transcript → ~45s windows for embedding.

Input shape (per `domain/transcript/reviewed.go`):
{
  "trackId": "...",
  "language": "ru",
  "blocks": [
    {"type": "paragraph", "start": 0, "end": 5000},
    {"type": "sentence", "start": 5000, "end": 8000,
        "text": "...", "reference": {"sourceId": "...", "tokens": [...]}},
    {"type": "verse:text", "start": 8000, "end": 12000,
        "text": ["line 1", "line 2"]},
    {"type": "verse:translation", "start": 8000, "end": 12000, "text": "..."}
  ]
}
"""

from __future__ import annotations

from dataclasses import dataclass

WINDOW_MS = 45_000
OVERLAP_BLOCKS = 2


@dataclass
class Chunk:
    track_id: str
    lang: str
    start_ms: int
    end_ms: int
    text: str
    reference_source_id: str | None


def _block_text(block: dict) -> str:
    t = block.get("type")
    text = block.get("text")
    if t == "verse:text" and isinstance(text, list):
        return " ".join(text)
    if isinstance(text, str):
        return text
    return ""


def _block_reference_source(block: dict) -> str | None:
    ref = block.get("reference")
    if isinstance(ref, dict):
        return ref.get("sourceId")
    return None


def chunk_reviewed(reviewed: dict) -> list[Chunk]:
    """Window-based chunker. Skips paragraph markers, overlaps by 2 blocks."""
    track_id: str = reviewed["trackId"]
    lang: str = reviewed["language"]
    raw_blocks = reviewed.get("blocks") or []
    # Skip paragraph markers — they have no text, only act as boundaries.
    blocks = [b for b in raw_blocks if b.get("type") != "paragraph"]
    if not blocks:
        return []

    out: list[Chunk] = []
    i = 0
    n = len(blocks)
    while i < n:
        win_start_idx = i
        win_start_ms = int(blocks[i]["start"])
        last_end_ms = int(blocks[i]["end"])
        texts: list[str] = []
        ref_source: str | None = None
        j = i
        while j < n:
            blk = blocks[j]
            last_end_ms = int(blk["end"])
            text = _block_text(blk).strip()
            if text:
                texts.append(text)
            if ref_source is None:
                ref_source = _block_reference_source(blk)
            # Close window if we'd exceed WINDOW_MS after this block.
            if last_end_ms - win_start_ms >= WINDOW_MS:
                j += 1
                break
            j += 1
        joined = " ".join(t for t in texts if t)
        if joined:
            out.append(Chunk(
                track_id=track_id,
                lang=lang,
                start_ms=win_start_ms,
                end_ms=last_end_ms,
                text=joined,
                reference_source_id=ref_source,
            ))
        if j >= n:
            break
        # Overlap: rewind 2 blocks (but always make forward progress).
        i = max(win_start_idx + 1, j - OVERLAP_BLOCKS)
    return out
